'use strict';

const path = require('node:path');
const ts = require('typescript');

const declaration = path.resolve(__dirname, '../../sdk/soduwork-app.d.ts');
const consumer = path.resolve(__dirname, '../fixtures/sdk-consumer.ts');

function compile(source, declarationFile = declaration, consumerFile = consumer) {
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Legacy,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    skipLibCheck: false,
  };
  const host = ts.createCompilerHost(options);
  const consumerPath = consumerFile.replace(/\\/g, '/');
  const canonicalConsumer = host.getCanonicalFileName(consumerPath);
  const isConsumer = file => host.getCanonicalFileName(file.replace(/\\/g, '/')) === canonicalConsumer;
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = file => isConsumer(file) ? source : readFile(file);
  host.fileExists = file => isConsumer(file) || fileExists(file);
  const program = ts.createProgram([declarationFile, consumerPath], options, host);
  return { program, diagnostics: ts.getPreEmitDiagnostics(program),
    consumer: program.getSourceFile(consumerPath)?.fileName ?? consumerPath };
}

function describe(diagnostics) {
  return diagnostics.map(row => {
    const place = row.file && row.start != null
      ? `${path.basename(row.file.fileName)}:${row.file.getLineAndCharacterOfPosition(row.start).line + 1}`
      : 'compiler';
    return `${place} TS${row.code}: ${ts.flattenDiagnosticMessageText(row.messageText, '\n')}`;
  }).join('\n');
}

function expression(value) {
  if (value instanceof Uint8Array) return `new Uint8Array(${JSON.stringify([...value])})`;
  if (Array.isArray(value)) return `[${value.map(expression).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}:${expression(item)}`).join(',')}}`;
  }
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

module.exports = { compile, describe, expression };
