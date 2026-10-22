// Electron entry. The TypeScript shell is compiled to electron/dist first.
try {
  require('./dist/electronMain.js');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ChordMini desktop shell is not compiled (${message}). Run npm run desktop:compile.`);
  process.exit(1);
}
