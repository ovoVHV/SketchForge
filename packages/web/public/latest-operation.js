export function createLatestOperationCoordinator() {
  let generation = 0;
  let activeToken = null;

  function isCurrent(token) {
    return token !== null && token === activeToken;
  }

  function invalidate(token) {
    if (!isCurrent(token)) return false;
    activeToken = null;
    return true;
  }

  return Object.freeze({
    begin() {
      generation += 1;
      activeToken = Object.freeze({ generation });
      return activeToken;
    },
    isCurrent,
    finish: invalidate,
    cancel: invalidate,
    cancelCurrent() {
      if (activeToken === null) return false;
      activeToken = null;
      return true;
    },
  });
}
