# n8n-nodes-pdf-form-filler-flat

An n8n community node for filling PDF form fields, generating visible editable field appearances, and creating final flattened PDF documents.

This node was built for complex AcroForm PDFs where standard PDF form filling can store field values internally but fail to display them visibly in PDF viewers.

It is especially useful for administrative PDFs, government forms, CERFA-style documents, contracts, onboarding forms, and other structured PDF templates.

## Features

- Fill PDF form fields from n8n JSON data
- Use static or dynamic field mappings
- Keep PDFs editable while making values visible
- Generate visible field appearances for page widgets
- Burn values directly onto PDF pages for final non-editable versions
- Discover existing PDF form fields
- Support text fields, checkboxes, radio groups, dropdowns, and option lists
- Preserve binary input/output inside n8n workflows

## Why this node exists

Some PDFs have complex or fragile AcroForm structures. In those PDFs, a normal form fill can produce a file where:

- the value exists inside the PDF field data,
- but the value is not visible in Adobe Acrobat or other PDF viewers,
- or flattening fails because some widgets are not correctly linked to pages.

This node adds two practical strategies for those cases:

1. **Editable Page Widgets**  
   Writes values into visible page widget annotations, generates appearances, and keeps the PDF editable.

2. **Burn Values Onto Page Widgets**  
   Draws values directly onto the PDF pages and removes form widgets, producing a final non-editable PDF.

## Installation

### Install from the n8n Community Nodes UI

In your self-hosted n8n instance:

1. Go to **Settings**
2. Open **Community Nodes**
3. Click **Install**
4. Enter:

```text
n8n-nodes-pdf-form-filler-flat
```

5. Confirm the installation
6. Restart n8n if needed

### Manual installation

For a self-hosted n8n instance, install the package inside the n8n user folder:

```bash
cd ~/.n8n/nodes
npm install n8n-nodes-pdf-form-filler-flat
```

Then restart n8n.

For Docker-based n8n:

```bash
docker exec -it -u node n8n sh
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install n8n-nodes-pdf-form-filler-flat
exit
docker restart n8n
```

If you install from a local `.tgz` package:

```bash
docker cp n8n-nodes-pdf-form-filler-flat-0.1.0.tgz n8n:/tmp/
docker exec -it -u node n8n sh
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install /tmp/n8n-nodes-pdf-form-filler-flat-0.1.0.tgz
exit
docker restart n8n
```

## Node name

After installation, search for:

```text
PDF Form Filler Flat
```

## Operations

### Fill Form

Fills a PDF form using JSON data and a field mapping.

Main parameters:

| Parameter | Description |
|---|---|
| PDF Binary Property | Binary property containing the input PDF |
| Mapping Source | Static or dynamic mapping |
| Dynamic Mapping Property | JSON property containing field mappings |
| Output Binary Property | Binary property for the output PDF |
| Output File Name | Name of the generated PDF |
| Flatten PDF | Whether to create a final non-editable PDF |
| Editable Page Widgets | Whether to fill visible page widgets and keep the PDF editable |
| Flatten Strategy | Strategy used when `Flatten PDF` is enabled |

### Discover Fields

Reads the PDF and returns the available form fields.

Use this operation to inspect field names before creating a mapping.

## Recommended modes

### 1. Standard editable PDF

Use this when the PDF behaves like a normal AcroForm PDF.

```text
Flatten PDF: false
Editable Page Widgets: false
```

The node fills the fields using the standard PDF form API.

### 2. Editable visible PDF

Use this when the values are stored but not visible in the PDF viewer.

```text
Flatten PDF: false
Editable Page Widgets: true
```

This mode fills the visible page widgets and generates appearances while keeping the fields editable.

Recommended for complex PDFs such as administrative forms or CERFA-style documents.

### 3. Final non-editable PDF

Use this when the PDF should be finalized and no longer editable.

```text
Flatten PDF: true
Flatten Strategy: Burn Values Onto Page Widgets
```

This mode draws values directly onto the PDF pages and removes interactive widgets.

Use it for final signed/exported/submitted PDFs.

## Basic workflow example

A typical n8n workflow:

```text
Download PDF Template
→ Code: Build data and fieldMappings
→ PDF Form Filler Flat
→ Google Drive Upload
```

## Input format

The node expects:

1. A binary PDF file
2. JSON values
3. A field mapping array

Example JSON item:

```json
{
  "employeur_nom": "Rugby Club Vannes",
  "employeur_siret": "12345678900000",
  "apprenti_nom_naissance": "DURAND",
  "apprenti_prenom": "Pierre",
  "fieldMappings": [
    {
      "dataKey": "employeur_nom",
      "pdfField": "Zone de texte 8"
    },
    {
      "dataKey": "employeur_siret",
      "pdfField": "Zone de texte 8_2"
    },
    {
      "dataKey": "apprenti_nom_naissance",
      "pdfField": "Zone de texte 8_15"
    },
    {
      "dataKey": "apprenti_prenom",
      "pdfField": "Zone de texte 8_17"
    }
  ]
}
```

## Dynamic mapping

Set the node like this:

```text
Mapping Source: Dynamic
Dynamic Mapping Property: fieldMappings
```

The value of `fieldMappings` must be an array:

```json
[
  {
    "dataKey": "employeur_nom",
    "pdfField": "Zone de texte 8"
  },
  {
    "dataKey": "employeur_siret",
    "pdfField": "Zone de texte 8_2"
  }
]
```

### Mapping fields

| Property | Required | Description |
|---|---:|---|
| dataKey | Yes | Key or dot-path in the n8n JSON data |
| pdfField | Yes | Exact PDF form field name |
| dateFormat | No | Optional date format override |
| pageNumber | No | Optional 1-based page number for advanced flattening |
| pageIndex | No | Optional 0-based page index for advanced flattening |

## Code node example

Use a Code node before `PDF Form Filler Flat`.

```javascript
const input = $input.first();

const binary = input.binary || {};
const binaryKey = Object.keys(binary)[0];

if (!binaryKey) {
  throw new Error('No PDF binary file found in input.');
}

return [
  {
    json: {
      employeur_nom: 'Rugby Club Vannes',
      employeur_siret: '12345678900000',
      apprenti_nom_naissance: 'DURAND',
      apprenti_prenom: 'Pierre',

      fieldMappings: [
        {
          dataKey: 'employeur_nom',
          pdfField: 'Zone de texte 8'
        },
        {
          dataKey: 'employeur_siret',
          pdfField: 'Zone de texte 8_2'
        },
        {
          dataKey: 'apprenti_nom_naissance',
          pdfField: 'Zone de texte 8_15'
        },
        {
          dataKey: 'apprenti_prenom',
          pdfField: 'Zone de texte 8_17'
        }
      ]
    },
    binary: {
      data: binary[binaryKey]
    }
  }
];
```

Then configure the node:

```text
Operation: Fill Form
PDF Binary Property: data
Mapping Source: Dynamic
Dynamic Mapping Property: fieldMappings
Output Binary Property: data
Output File Name: filled-form.pdf
Flatten PDF: false
Editable Page Widgets: true
```

## Editable vs final PDF

This node can produce two kinds of PDF outputs.

### Editable prefilled PDF

Use this for review and manual correction.

```text
Flatten PDF: false
Editable Page Widgets: true
```

The fields should remain clickable and editable in Adobe Acrobat.

### Final non-editable PDF

Use this after validation.

```text
Flatten PDF: true
Flatten Strategy: Burn Values Onto Page Widgets
```

The values are drawn directly onto the PDF. The result is no longer editable as a form.

## Recommended production pattern

For administrative workflows, generate two files:

```text
PDF_EDITABLE_PREFILLED.pdf
PDF_FINAL_NON_EDITABLE.pdf
```

Example n8n architecture:

```text
Download PDF Template
→ Code: Build mapping
→ PDF Form Filler Flat, Flatten PDF false, Editable Page Widgets true
→ Upload Drive: editable prefilled PDF

Download PDF Template
→ Code: Build mapping
→ PDF Form Filler Flat, Flatten PDF true, Burn Values Onto Page Widgets
→ Upload Drive: final non-editable PDF
```

## Troubleshooting

### The PDF is generated but I see no text

Use:

```text
Flatten PDF: false
Editable Page Widgets: true
```

This creates visible appearances while keeping the PDF editable.

### The PDF is filled but only shows values when clicking fields

The PDF likely has missing or outdated field appearances.

Use:

```text
Editable Page Widgets: true
```

### The PDF is no longer editable

You probably used one of these modes:

```text
Flatten PDF: true
Burn Values Onto Page Widgets
```

or

```text
PDF-lib Form Flatten
```

To keep the PDF editable, use:

```text
Flatten PDF: false
Editable Page Widgets: true
```

### I get `Could not find page for PDFRef`

This happens with some complex AcroForm PDFs where widgets are not correctly linked to pages.

Avoid standard `PDF-lib Form Flatten` for those files.

Use:

```text
Flatten PDF: false
Editable Page Widgets: true
```

for editable output, or:

```text
Flatten PDF: true
Flatten Strategy: Burn Values Onto Page Widgets
```

for final output.

### I get `Expected instance of PDFDict, but got instance of undefined`

Some widget annotations may be missing optional references such as `/Parent`.

Use the latest version of this node and retry with:

```text
Editable Page Widgets: true
```

### I do not know the PDF field names

Use the `Discover Fields` operation first.

Then map your JSON keys to the exact PDF field names returned by the node.

## Development

Clone the repository:

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/n8n-nodes-pdf-form-filler-flat.git
cd n8n-nodes-pdf-form-filler-flat
```

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Create a local package:

```bash
npm pack
```

Install locally in Docker-based n8n:

```bash
docker cp n8n-nodes-pdf-form-filler-flat-0.1.0.tgz n8n:/tmp/
docker exec -it -u node n8n sh
cd ~/.n8n/nodes
npm install /tmp/n8n-nodes-pdf-form-filler-flat-0.1.0.tgz
exit
docker restart n8n
```

## package.json requirements

This package must include the n8n community node keyword:

```json
{
  "keywords": [
    "n8n-community-node-package",
    "n8n",
    "n8n-nodes",
    "pdf",
    "pdf-form",
    "acroform"
  ]
}
```

It must also declare the node file inside the `n8n` attribute:

```json
{
  "n8n": {
    "nodes": [
      "dist/nodes/PdfFormFiller/PdfFormFiller.node.js"
    ]
  }
}
```

## Publishing

Before publishing:

```bash
npm run build
npm pack
```

Test the `.tgz` file locally in n8n.

Then publish:

```bash
npm publish
```

For scoped packages:

```bash
npm publish --access public
```

## Versioning

Use semantic versioning.

For small fixes:

```bash
npm version patch
npm publish
git push --follow-tags
```

For new features:

```bash
npm version minor
npm publish
git push --follow-tags
```

## Compatibility

Tested with:

```text
n8n: 2.x self-hosted
Node.js: 20+
PDF library: pdf-lib
```

## Limitations

- Complex PDFs may require `Editable Page Widgets` mode.
- Some PDFs may use unusual field names.
- Some date fields may be split into day, month, and year fields.
- Final flattened PDFs are not meant to remain editable.
- This node does not validate legal or administrative correctness of the filled document.

## Privacy

This node processes PDF files locally inside your n8n instance.

It does not send PDF data to an external API.

## License

MIT

## Credits

Built for n8n workflows that need reliable PDF form filling, especially where standard AcroForm filling does not create visible field appearances.