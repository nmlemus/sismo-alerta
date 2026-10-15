// Runs before the page draws: applies the theme the visitor chose (auto = the system's),
// so a forced light or dark theme doesn't flash the other one first.
(function () {
  try {
    var t = localStorage.getItem('sismo-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* storage off: follow the system */ }
}());
