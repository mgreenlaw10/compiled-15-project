import { describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { createDefaultRegistry } from '../../src/core/analyzer/languages'
import { languageOf } from '../../src/shared/languages'
import type { DiscoveredFile } from '../../src/core/analyzer/scan'
import { analyzeProject } from '../../src/core/analyzer'
import { validateGraph } from '../../src/shared/graph/model'

async function analyze(sources: Record<string, string>, projectRoot = os.tmpdir()) {
  const files: DiscoveredFile[] = Object.entries(sources).map(([name, content]) => ({
    path: name, absolutePath: path.join(projectRoot, name), content,
    language: languageOf(name), byteSize: Buffer.byteLength(content), loc: content.split('\n').length
  }))
  const results = []
  for (const { analyzer, files: partition } of createDefaultRegistry().partition(files)) {
    results.push(...await analyzer.analyze(partition, { projectRoot, allFiles: files, pathAliases: {}, baseUrl: '' }))
  }
  return new Map(results.map((r) => [r.path, r]))
}

describe('Python analysis', () => {
  it('resolves src packages, relative imports, child modules, aliases and multiline imports', async () => {
    const results = await analyze({
      'src/shop/__init__.py': '',
      'src/shop/db/__init__.py': 'from .client import Client',
      'src/shop/db/client.py': 'class Client:\n    pass',
      'src/shop/api.py': `import os, shop.db.client as db
from .db import (
    client as storage,
)
from shop.db.client import Client
from .missing import Nope
# from .fake import Fake
doc = "from .fake import Fake"
__all__ = ['API', '_public']
class API:
    def method(self): pass
async def _public(): pass
def _private(): pass`
    })
    const api = results.get('src/shop/api.py')!
    expect(api.imports.map((i) => i.resolvedPath)).toEqual([
      null, 'src/shop/db/client.py', 'src/shop/db/client.py', 'src/shop/db/client.py', null
    ])
    expect(api.imports[0].packageName).toBe('os')
    expect(api.imports[2].symbols).toEqual(['client'])
    expect(api.exportedNames).toEqual(['API', '_public'])
    expect(api.symbols.find((s) => s.name === '_public')?.exported).toBe(true)
    expect(api.symbols.map((s) => s.name)).not.toContain('method')
    expect(api.problems).toHaveLength(1)
    expect(api.problems[0]).toContain('.missing')
  })

  it('reports ambiguous modules and parse errors without inventing edges', async () => {
    const results = await analyze({
      'pkg/core.py': '', 'src/pkg/core.py': '',
      'main.py': 'import pkg.core\nfrom .missing import x\ndef broken(:\n  pass'
    })
    const main = results.get('main.py')!
    expect(main.imports[0].resolvedPath).toBeNull()
    expect(main.problems.join(' ')).toContain('ambiguous')
    expect(main.problems.join(' ')).toContain('syntax error')
    expect(main.problems.join(' ')).toContain('top-level package')
  })
})

describe('Java analysis', () => {
  it('resolves same-package types while respecting imported names and type parameters', async () => {
    const results = await analyze({
      'Db.java': 'package app; public class Db {}',
      'Row.java': 'package app; public class Row {}',
      'Local.java': 'package app; public class Local { Db db; }',
      'Imported.java': 'package app; import other.Db; public class Imported<Row> { Db db; Row row; }'
    })
    expect(results.get('Local.java')!.imports[0]).toMatchObject({ resolvedPath: 'Db.java', typeOnly: true })
    expect(results.get('Imported.java')!.imports).toHaveLength(1)
    expect(results.get('Imported.java')!.imports[0].external).toBe(true)
  })
  it('indexes declared packages, including nested types, static imports and wildcards', async () => {
    const results = await analyze({
      'arbitrary/Client.java': 'package com.shop.db; public class Client { public static class Nested {} public static void run() {} }',
      'arbitrary/Row.java': 'package com.shop.db; public record Row(int id) {}',
      'src/Api.java': `package com.shop.api;
import com.shop.db.Client;
import com.shop.db.Client.Nested;
import static com.shop.db.Client.run;
import com.shop.db.*;
import java.util.List;
import com.shop.db.Missing;
// import imaginary.Fake;
public interface Api {}`
    })
    const api = results.get('src/Api.java')!
    expect(api.imports.filter((i) => i.resolvedPath === 'arbitrary/Client.java')).toHaveLength(4)
    expect(api.imports.some((i) => i.resolvedPath === 'arbitrary/Row.java')).toBe(true)
    expect(api.imports.find((i) => i.specifier === 'java.util.List')?.external).toBe(true)
    expect(api.problems).toHaveLength(1)
    expect(api.problems[0]).toContain('Missing')
    expect(api.symbols[0]).toMatchObject({ name: 'Api', kind: 'interface', exported: true, line: 9 })
    expect(results.get('arbitrary/Row.java')!.symbols[0]).toMatchObject({ name: 'Row', kind: 'class' })
  })
})

describe('C and C++ analysis', () => {
  it('reports ambiguous include roots and conflicting compiler configurations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-ambiguous-'))
    try {
      const sources = {
        'src/main.cpp': '#include <model.hpp>', 'include/model.hpp': '', 'src/model.hpp': ''
      }
      const inferred = (await analyze(sources, root)).get('src/main.cpp')!
      expect(inferred.imports[0]).toMatchObject({ resolvedPath: null, external: false })
      expect(inferred.problems.join(' ')).toContain('ambiguous')
      await fs.writeFile(path.join(root, 'compile_commands.json'), JSON.stringify([
        { file: 'src/main.cpp', arguments: ['c++', '-Iinclude'] },
        { file: 'src/main.cpp', command: 'c++ -Isrc' }
      ]))
      const configured = (await analyze(sources, root)).get('src/main.cpp')!
      expect(configured.imports[0].resolvedPath).toBeNull()
      expect(configured.problems.join(' ')).toContain('Multiple compiler')
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
  it('resolves local and conventional include paths and handles C++ headers and declarations', async () => {
    const results = await analyze({
      'include/models.hpp': 'namespace shop { class Model {}; using Id = int; enum State { Ready }; }',
      'src/local.h': 'int run(int x);',
      'src/main.c': `#include "local.h"
#include <stdio.h>
#include "missing.h"
static int helper(void) { return 0; }
int run(int x) { return x; }`,
      'src/main.cpp': `#include <models.hpp>
#include HEADER
// #include "fake.h"
namespace shop { int render() { return 1; } }`
    })
    const c = results.get('src/main.c')!
    expect(c.imports[0].resolvedPath).toBe('src/local.h')
    expect(c.imports[1]).toMatchObject({ external: true, packageName: 'stdio.h' })
    expect(c.problems).toHaveLength(1)
    expect(c.symbols.find((s) => s.name === 'helper')?.exported).toBe(false)
    expect(c.exportedNames).toEqual(['run'])
    const cpp = results.get('src/main.cpp')!
    expect(cpp.imports[0].resolvedPath).toBe('include/models.hpp')
    expect(cpp.problems.join(' ')).toContain('macro')
    expect(cpp.symbols[0].name).toBe('render')
    expect(results.get('include/models.hpp')!.exportedNames).toEqual(['Id', 'Model', 'State'])
  })

  it('uses compilation database include order and quoted includes take local precedence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-includes-'))
    try {
      await fs.writeFile(path.join(root, 'compile_commands.json'), JSON.stringify([
        { directory: root, file: 'src/main.cpp', arguments: ['c++', '-I', 'custom include', '-Isecond', 'src/main.cpp'] }
      ]))
      const results = await analyze({
        'src/main.cpp': '#include <model.hpp>\n#include "local.h"',
        'custom include/model.hpp': 'class Model {};', 'second/model.hpp': '',
        'src/local.h': '', 'custom include/local.h': ''
      }, root)
      expect(results.get('src/main.cpp')!.imports.map((i) => i.resolvedPath)).toEqual([
        'custom include/model.hpp', 'src/local.h'
      ])
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})

it('scans and builds a valid module graph for a mixed-language repository', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cartograph-languages-'))
  try {
    const sources = {
      'src/api/main.py': 'from db.client import Client',
      'src/db/client.py': 'class Client: pass',
      'src/api/Api.java': 'package app.api; import app.db.Db; public class Api {}',
      'src/db/Db.java': 'package app.db; public class Db {}',
      'src/api/main.cpp': '#include "../db/db.hpp"\nint run() { return 0; }',
      'src/db/db.hpp': 'class Database {};',
      'src/api/js.ts': 'export const value = 1',
      '.venv/ignored.py': 'class Ignored: pass',
      'target/Ignored.java': 'class Ignored {}'
    }
    for (const [name, content] of Object.entries(sources)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
      await fs.writeFile(path.join(root, name), content)
    }
    const { graph, analyses } = await analyzeProject(root)
    expect(graph.analysis.fileCount).toBe(7)
    expect(graph.analysis.languages).toEqual({ python: 2, java: 2, cpp: 2, typescript: 1 })
    expect(validateGraph(graph).filter((p) => p.severity === 'error')).toEqual([])
    expect(analyses.flatMap((a) => a.problems)).toEqual([])
    expect(graph.modules.flatMap((m) => m.symbols).map((s) => s.name)).toContain('Database')
    const evidence = graph.edges.flatMap((e) => e.evidence)
    for (const name of ['src/api/main.py', 'src/api/Api.java', 'src/api/main.cpp']) {
      expect(evidence.some((e) => e.fromFile === name && e.toFile.startsWith('src/db/'))).toBe(true)
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
