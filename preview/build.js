// Builds preview/dist/index.html: the page with the shared pipeline data embedded.
const fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "..");
const data = fs.readFileSync(path.join(root, "skills/skill-router/data/pipelines.json"), "utf8").trim().replace(/</g, "\\u003c");
const page = fs.readFileSync(path.join(__dirname, "page.html"), "utf8").replace("__DATA__", data);
fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "dist", "index.html"), page);
console.log("preview/dist/index.html", page.length, "bytes");
