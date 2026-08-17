import * as fs from "node:fs"
import * as path from "node:path"

const json = JSON.parse(fs.readFileSync("package.json", "utf8"))

const pkg = {
  name: json.name,
  version: json.version,
  type: json.type,
  description: json.description,
  main: "bin.js",
  bin: { "sarah-computer-controller": "bin.js" },
  engines: json.engines,
  dependencies: json.dependencies,
  peerDependencies: json.peerDependencies,
  repository: json.repository,
  author: json.author,
  license: json.license,
  bugs: json.bugs,
  homepage: json.homepage,
  keywords: json.keywords
}

fs.writeFileSync(path.join("dist", "package.json"), JSON.stringify(pkg, null, 2))
console.log("[Build] dist/package.json written.")
