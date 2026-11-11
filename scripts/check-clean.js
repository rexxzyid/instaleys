import { readdir, readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

const ROOTS = ['src', 'test', 'examples', 'scripts']
const slash = '/'
const LINE_COMMENT = new RegExp(`(^|\\s)${slash}${slash}`)
const BLOCK_COMMENT = new RegExp(`${slash}\\*`)
const STAR_LINE = /^\s*\*/
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff]/
const URL_LINE = /https?:\/\//

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path)
      return extname(entry.name) === '.js' ? [path] : []
    })
  )
  return files.flat()
}

const violations = []

for (const file of (await Promise.all(ROOTS.map(walk))).flat()) {
  const lines = (await readFile(file, 'utf8')).split('\n')
  lines.forEach((line, index) => {
    const where = `${file}:${index + 1}`
    if (INVISIBLE.test(line)) violations.push(`${where} karakter tak terlihat`)
    if (URL_LINE.test(line)) return
    if (LINE_COMMENT.test(line) || BLOCK_COMMENT.test(line) || STAR_LINE.test(line)) {
      violations.push(`${where} komentar: ${line.trim().slice(0, 80)}`)
    }
  })
}

if (violations.length) {
  console.error(violations.join('\n'))
  console.error(`\n${violations.length} pelanggaran`)
  process.exit(1)
}

console.log('bersih: tidak ada komentar atau karakter tak terlihat')
