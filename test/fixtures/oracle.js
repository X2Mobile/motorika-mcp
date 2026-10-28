// Shared page-state oracle for fixtures: counters and an ordered event log.
window.__events = [];
window.__counts = {};
window.__log = function (e) {
  window.__events.push(e);
};
window.__count = function (k) {
  window.__counts[k] = (window.__counts[k] || 0) + 1;
};
