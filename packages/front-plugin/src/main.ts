import Front from "@frontapp/plugin-sdk";
import { settingsFrom } from "./capture";
import { ManualCapture } from "./controller";
import { capturePost } from "./transport";
import { mount } from "./ui";

function main(): void {
  const root = document.getElementById("app");
  if (!root) return;
  try {
    const settings = settingsFrom(new URLSearchParams(location.search));
    let render = (): void => {};
    const controller = new ManualCapture(settings, capturePost(), () => render());
    render = mount(root, controller);
    render();
    const subscription = Front.contextUpdates.subscribe((context) => {
      void controller.connect(context.type === "singleConversation" ? context : null);
    });
    const interval = window.setInterval(() => void controller.pollDraft(), 2000);
    window.addEventListener(
      "pagehide",
      () => {
        window.clearInterval(interval);
        subscription.unsubscribe();
        controller.close();
      },
      { once: true },
    );
  } catch {
    root.textContent = "The plugin could not start. Check its non-secret settings and reload.";
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main, { once: true });
else main();
