// Self-check of frontend/src/lib/thermals.ts (averaging, CPU profiles, colour levels). Run: node scripts/check-thermals.mjs
import assert from "node:assert/strict";
import { cpuProfile, driveKind, recommendedLimits, smooth, tempLevel } from "../frontend/src/lib/thermals.ts";

const snap = (pkg, core0, gpu, drive) => ({
  cpu: { package_temp_c: pkg, cores: [{ core_id: 0, temp_c: core0, freq_mhz: 4000, load_pct: 5 }], avg_freq_mhz: 4000, min_freq_mhz: 800, max_freq_mhz: 5000 },
  gpus: [{ slot: "01:00.0", name: "GPU", temp_c: gpu, hotspot_temp_c: null, fan_rpm_or_pct: 30, fan_unit: "%", power_w: 20, vram_used_mb: 1, vram_total_mb: 2, utilization_pct: 0 }],
  drives: [{ device: "/dev/nvme0n1", model: "x", temp_c: drive, wear_pct: 99 }],
  memory: [],
  chassis_fans: [],
  timestamp: 0,
});

// One 95 °C spike between 50 °C readings over 10 s (2 s apart) averages to 59 °C: no red.
const s = [50, 50, 95, 50, 50].map((t, i) => ({ at: i * 2000, d: snap(t, t, 40, 35) }));
const a = smooth(s, 10_000);
assert.equal(a.cpu.package_temp_c, 59);
assert.equal(a.cpu.cores[0].temp_c, 59);
assert.equal(a.gpus[0].temp_c, 40);
assert.equal(a.cpu.avg_freq_mhz, 4000, "clocks stay current");
// Samples older than the window drop out: a sustained 95 °C shows as 95 °C.
const hot = [...s, ...[95, 95, 95, 95, 95, 95].map((t, i) => ({ at: 10_000 + i * 2000, d: snap(t, t, 40, 35) }))];
assert.equal(smooth(hot, 10_000).cpu.package_temp_c, 95);
assert.equal(smooth([], 10_000), null);

// Profiles: first match wins, laptop and desktop K parts, AMD X3D before the general 7000 rule.
assert.equal(cpuProfile("Intel(R) Core(TM) i9-14900HX").id, "intel-hx");
assert.equal(cpuProfile("Intel(R) Core(TM) i9-14900K").id, "intel-k");
assert.equal(cpuProfile("Intel(R) Core(TM) i5-12400").id, "intel-core");
assert.equal(cpuProfile("AMD Ryzen 7 7800X3D 8-Core Processor").id, "amd-x3d");
assert.equal(cpuProfile("AMD Ryzen 9 7950X 16-Core Processor").id, "amd-zen4-5");
assert.equal(cpuProfile("AMD Ryzen 7 5700U with Radeon Graphics").id, "amd-mobile");
assert.equal(cpuProfile("AMD Ryzen 9 5950X 16-Core Processor").id, "amd-zen3");
assert.equal(cpuProfile("Intel(R) N100").id, "intel-n");
assert.equal(cpuProfile(null).id, "generic");

// Levels: 84 °C on a 14900HX is fine, the old 45/55 rule called it red.
const hx = recommendedLimits("Intel(R) Core(TM) i9-14900HX");
assert.equal(tempLevel(84, hx.cpu), "ok");
assert.equal(tempLevel(90, hx.cpu), "warn");
assert.equal(tempLevel(98, hx.cpu), "hot");
assert.equal(tempLevel(null, hx.cpu), "none");
assert.equal(tempLevel(50, hx.hdd), "warn");
assert.equal(driveKind("/dev/nvme0n1"), "ssd");
assert.equal(driveKind("/dev/sda", "hdd"), "hdd");
assert.equal(driveKind("/dev/sdd", "ssd"), "ssd");
console.log("thermals self-check: ok");
