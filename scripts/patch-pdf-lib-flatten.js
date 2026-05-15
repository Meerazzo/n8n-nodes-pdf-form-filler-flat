const fs = require('fs');

const files = [
  'node_modules/pdf-lib/cjs/api/form/PDFForm.js',
  'node_modules/pdf-lib/es/api/form/PDFForm.js',
];

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.warn(`SKIP missing file: ${file}`);
    continue;
  }

  let src = fs.readFileSync(file, 'utf8');
  const before = src;

  // 1) In findWidgetPage(), do not throw when the widget has no page.
  src = src.replace(
    /if \(page === undefined\) \{\s*throw new Error\(`Could not find page for PDFRef \$\{widgetRef\}`\);\s*\}/g,
    `if (page === undefined) {
            return undefined;
        }`,
  );

  src = src.replace(
    /if \(page === undefined\) \{\s*throw new Error\("Could not find page for PDFRef "\.concat\(widgetRef\)\);\s*\}/g,
    `if (page === undefined) {
            return undefined;
        }`,
  );

  // 2) In flatten(), skip orphan widgets instead of crashing.
  src = src.replace(
    /((?:const|let|var)\s+page\s*=\s*this\.findWidgetPage\(widget\);\s*)((?:const|let|var)\s+widgetRef\s*=\s*this\.findWidgetAppearanceRef\(field,\s*widget\);)/g,
    `$1if (page === undefined) {
                continue;
            }
            $2`,
  );

  // 3) In removeField(), skip orphan widgets instead of crashing.
  src = src.replace(
    /((?:const|let|var)\s+page\s*=\s*this\.findWidgetPage\(widget\);\s*)pages\.add\(page\);/g,
    `$1if (page === undefined) {
            continue;
        }
        pages.add(page);`,
  );

  if (src === before) {
    console.warn(`WARNING no change made in ${file}`);
  } else {
    fs.writeFileSync(file, src);
    console.log(`PATCHED ${file}`);
  }
}

