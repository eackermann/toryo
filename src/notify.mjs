import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isWsl } from "./util.mjs";

const POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const xml = (s) =>
  String(s ?? "")
    .slice(0, 240)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * The PowerShell command for a Windows toast, as -EncodedCommand expects it.
 * The script is fixed; the message travels as base64 data that the script
 * decodes, so nothing in a title or body can become PowerShell code.
 */
export function toastCommand(title, body) {
  const toast = `<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`;
  const data = Buffer.from(toast, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$x = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$x.LoadXml([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${data}')))`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join("; ");
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Desktop notifications: a Windows toast from WSL, and an optional ntfy topic for a phone. */
export class Notifier {
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  send(title, body) {
    const cfg = this.getConfig()?.notify ?? {};
    if (cfg.windows !== false) this.windowsToast(title, body);
    if (cfg.ntfyTopic) this.ntfy(cfg.ntfyTopic, cfg.ntfyServer, title, body);
  }

  windowsToast(title, body) {
    const ps = isWsl() && existsSync(POWERSHELL) ? POWERSHELL : process.platform === "win32" ? "powershell.exe" : null;
    if (!ps) return;
    try {
      const child = spawn(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", toastCommand(title, body)], {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => {});
      child.unref();
    } catch {
      /* notifications are best effort */
    }
  }

  ntfy(topic, server, title, body) {
    const url = `${(server || "https://ntfy.sh").replace(/\/$/, "")}/${encodeURIComponent(topic)}`;
    fetch(url, { method: "POST", headers: { Title: String(title).slice(0, 200) }, body: String(body ?? "") }).catch(
      () => {},
    );
  }
}
