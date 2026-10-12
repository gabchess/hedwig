(function () {
  var button = document.querySelector(".menu-btn");
  var menu = document.getElementById("menu");
  if (!button || !menu) return;
  menu.addEventListener("toggle", function (event) {
    button.setAttribute("aria-expanded", event.newState === "open" ? "true" : "false");
  });
})();
