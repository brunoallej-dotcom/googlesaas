// Runner de testes sem binários nativos: transpila TS com o TypeScript já presente
// nas devDependencies e resolve o alias @/ usado no Next.js.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolve(filename, parent, ...args) {
  const mapped = filename.startsWith('@/')
    ? path.join(__dirname, '..', 'src', filename.slice(2))
    : filename;
  return originalResolveFilename.call(this, mapped, parent, ...args);
};

for (const extension of ['.ts', '.tsx']) {
  require.extensions[extension] = (mod, filename) => {
    const content = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(content, {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        // Componentes do dashboard (.tsx) são renderizados no servidor nos testes.
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    mod._compile(output, filename);
  };
}
