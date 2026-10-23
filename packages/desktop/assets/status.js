function update(status) {
  if (!status) return;
  const state = document.getElementById("state");
  state.textContent = status.kind === "error" ? "启动或运行失败" : "请稍候";
  state.className = status.kind === "error" ? "error" : "";
  document.getElementById("message").textContent = status.message;
  document.getElementById("logs").textContent = `日志位置：${status.logPath}`;
}
window.rccDesktop.onStatus(update);
window.rccDesktop.getStartupState().then(update);
document.getElementById("open-logs").addEventListener("click", () => window.rccDesktop.openLogs());
document.getElementById("exit").addEventListener("click", () => window.rccDesktop.exit());
