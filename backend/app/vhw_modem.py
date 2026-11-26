#!/usr/bin/env python3
"""SolarDeck virtual 56k Hayes modem: an AT-command emulator on a guest's serial port that "dials" over TCP/IP.

Runs on its own (standard library only), copied to the host for VMs or into a container:
  vhw_modem.py --unix PATH        connect to a VM's serial port socket (the hypervisor creates it)
  vhw_modem.py --pty LINK         create a pseudo-terminal and point LINK (e.g. /dev/ttyS0) at it (containers)
Options: --host H --port P  the default dial target (ATDT with no number, or a number that is not host:port).

Dialing: ATDT<host>:<port> or ATDT<host>/<port> opens a TCP connection and answers CONNECT 56000; plain digits dial
the default target. "+++" (with a 1 s guard time) returns to command mode, ATH hangs up, ATO goes back online.
"""
import argparse
import os
import re
import select
import socket
import sys
import time

BAUD = 56000


class Modem:
    """Command-mode state machine (no I/O): feed() takes guest bytes and returns (reply bytes, action)."""

    def __init__(self, host: str = "", port: int = 0):
        self.host, self.port = host, port
        self.echo, self.verbose, self.quiet = True, True, False
        self.buf = b""
        self.s0 = 0  # rings before auto-answer (stored only)

    def result(self, word: str, code: int) -> bytes:
        if self.quiet:
            return b""
        return (f"\r\n{word}\r\n" if self.verbose else f"{code}\r").encode()

    def target(self, number: str) -> tuple[str, int] | None:
        number = number.strip().strip('"')
        m = re.fullmatch(r"([A-Za-z0-9._-]+)[:/](\d{1,5})", number)
        if m:
            return m.group(1), int(m.group(2))
        return (self.host, self.port) if self.host and self.port else None

    def command(self, line: str) -> tuple[bytes, tuple | None]:
        """One AT command line -> (reply, action); action is ("dial", host, port), ("hangup",), ("online",) or None."""
        up = line.strip()
        if not up.upper().startswith("AT"):
            return b"", None
        body, out, action = up[2:], b"", None
        i = 0
        while i < len(body):
            c = body[i].upper()
            i += 1
            if c in " ":
                continue
            if c == "D":
                rest = body[i:].lstrip()
                if rest[:1].upper() in ("T", "P"):
                    rest = rest[1:]
                t = self.target(rest)
                if not t:
                    return self.result("NO CARRIER", 3), None
                return b"", ("dial", *t)
            num = re.match(r"\d*", body[i:]).group(0)
            i += len(num)
            n = int(num or 0)
            if c == "Z" or c == "&":
                if c == "&":
                    i += 1 if i < len(body) else 0  # &F, &C1, &D2, ... accepted and ignored
                    i += len(re.match(r"\d*", body[i:]).group(0))
                else:
                    self.echo, self.verbose, self.quiet = True, True, False
            elif c == "E":
                self.echo = n == 1
            elif c == "V":
                self.verbose = n == 1
            elif c == "Q":
                self.quiet = n == 1
            elif c == "H":
                action = ("hangup",)
            elif c == "O":
                return b"", ("online",)
            elif c == "A":
                return self.result("NO CARRIER", 3), None  # nobody is calling in
            elif c == "I":
                out += b"\r\nSolarDeck Virtual 56k Modem\r\n"
            elif c == "S":
                m = re.match(r"=(\d+)|\?", body[i:])
                if m and m.group(0) == "?":
                    out += f"\r\n{self.s0:03d}\r\n".encode() if n == 0 else b"\r\n000\r\n"
                elif m:
                    self.s0 = int(m.group(1)) if n == 0 else self.s0
                i += len(m.group(0)) if m else 0
            elif c in "LMXWB\\%N":
                i += len(re.match(r"\d*", body[i:]).group(0))
            else:
                return self.result("ERROR", 4), None
        return out + self.result("OK", 0), action

    def feed(self, data: bytes) -> tuple[bytes, list[tuple]]:
        """Bytes from the guest in command mode -> (echo + replies, actions)."""
        out, actions = b"", []
        for b in data:
            ch = bytes([b])
            if self.echo:
                out += ch
            if ch in (b"\r", b"\n"):
                line, self.buf = self.buf.decode(errors="replace"), b""
                if line.strip():
                    reply, act = self.command(line)
                    out += reply
                    if act:
                        actions.append(act)
            elif ch in (b"\x08", b"\x7f"):
                self.buf = self.buf[:-1]
            else:
                self.buf += ch
        return out, actions


def open_port(args) -> int:
    if args.unix:
        for _ in range(600):  # the VM may not be running yet
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.connect(args.unix)
                args._sock = s
                return s.fileno()
            except OSError:
                time.sleep(2)
        sys.exit(f"serial socket {args.unix} did not appear")
    import tty
    master, slave = os.openpty()
    tty.setraw(slave)
    name = os.ttyname(slave)
    if os.path.lexists(args.pty):
        os.unlink(args.pty)
    os.symlink(name, args.pty)
    args._slave = slave  # keep the slave open, so the guest side never sees a hangup between programs
    return master


def serve(args) -> None:
    fd = open_port(args)
    modem, peer, online, plus, last = Modem(args.host, args.port), None, False, 0, 0.0

    def write(b: bytes):
        if b:
            os.write(fd, b)

    while True:
        rl = [fd] + ([peer] if peer else [])
        r, _, _ = select.select(rl, [], [], 1.0)
        if peer and peer in r:
            try:
                data = peer.recv(4096)
            except OSError:
                data = b""
            if not data:
                peer.close()
                peer, online = None, False
                write(modem.result("NO CARRIER", 3))
            elif online:
                write(data)
        if fd in r:
            data = os.read(fd, 4096)
            if not data:
                if args.unix:
                    return  # the VM stopped; systemd restarts us and we wait for the socket again
                continue
            if online:
                now = time.monotonic()
                plus = plus + data.count(b"+") if data.strip(b"+") == b"" and (plus or now - last > 1) else 0
                last = now
                if plus >= 3:
                    online, plus = False, 0
                    time.sleep(1)
                    write(modem.result("OK", 0))
                    continue
                if peer:
                    peer.sendall(data)
                continue
            out, actions = modem.feed(data)
            write(out)
            for act in actions:
                if act[0] == "dial":
                    try:
                        peer = socket.create_connection((act[1], act[2]), timeout=30)
                        peer.settimeout(None)
                        online = True
                        write(modem.result(f"CONNECT {BAUD}", 1))
                    except OSError:
                        peer = None
                        write(modem.result("NO CARRIER", 3))
                elif act[0] == "hangup" and peer:
                    peer.close()
                    peer, online = None, False
                elif act[0] == "online" and peer:
                    online = True
                    write(modem.result(f"CONNECT {BAUD}", 1))
                elif act[0] == "online":
                    write(modem.result("NO CARRIER", 3))


def main() -> None:
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--unix")
    g.add_argument("--pty")
    p.add_argument("--host", default="")
    p.add_argument("--port", type=int, default=0)
    serve(p.parse_args())


if __name__ == "__main__":
    main()
