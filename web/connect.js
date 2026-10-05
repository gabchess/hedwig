(() => {
  "use strict";

  const button = document.getElementById("copy-prompt");
  const prompt = document.getElementById("install-prompt");
  const status = document.getElementById("copy-status");
  if (!button || !prompt || !status) return;

  button.hidden = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "";
    try {
      await navigator.clipboard.writeText(prompt.textContent.trim());
      status.textContent = "Copied. Paste it into your agent.";
    } catch {
      prompt.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(prompt);
      selection?.removeAllRanges();
      selection?.addRange(range);
      status.textContent =
        "Copy the selected prompt, then paste it into your agent.";
    } finally {
      button.disabled = false;
    }
  });
})();
