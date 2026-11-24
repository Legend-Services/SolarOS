// Minimal typings for the parts of noVNC we use (the package ships none).
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { credentials?: { password?: string }; wsProtocols?: string[] });
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    sendCredentials(credentials: { password?: string }): void;
    sendCtrlAltDel(): void;
    disconnect(): void;
    focus(): void;
  }
}
