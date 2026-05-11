async (page) => {
  return JSON.stringify(globalThis.__captured || 'NO_CAPTURE_GLOBAL', null, 2);
}
