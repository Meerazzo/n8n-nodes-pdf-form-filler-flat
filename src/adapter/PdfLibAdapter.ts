import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFForm,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFString,
  PDFTextField,
  StandardFonts,
  rgb,
} from 'pdf-lib';

import { FieldInfo, IPdfAdapter, PdfFieldType, FieldMappingEntry } from '../types';
import { PdfLoadError, NoFormError, FieldNotFoundError } from '../errors/PdfFormFillerError';
import { FieldTypeDetector } from './FieldTypeDetector';

export interface PdfLibAdapterOptions {
  flattenPdf?: boolean;
  flattenStrategy?: 'pdfLib' | 'pageWidgets';
  editablePageWidgets?: boolean;
}

/**
 * Wraps the pdf-lib library behind the IPdfAdapter interface.
 *
 * Handles PDF loading, field discovery, value setting, and saving.
 * All pdf-lib specifics are isolated in this class — the rest of the
 * codebase interacts only through IPdfAdapter.
 */
export class PdfLibAdapter implements IPdfAdapter {
  private pdfDoc: PDFDocument | null = null;
  private form: PDFForm | null = null;
  private pageHints = new Map<string, number>();
  private pageWidgetsBurned = false;

  constructor(private readonly options: PdfLibAdapterOptions = {}) {}

  /**
   * Load a PDF document from bytes.
   *
   * @param pdfBytes - The raw PDF file bytes.
   * @throws PdfLoadError if the bytes are invalid or the PDF cannot be loaded.
   */
  async loadDocument(pdfBytes: Uint8Array): Promise<void> {
    try {
      this.pdfDoc = await PDFDocument.load(pdfBytes, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PdfLoadError(message);
    }

    try {
      this.form = this.pdfDoc.getForm();
    } catch {
      throw new NoFormError();
    }
  }

  /**
   * Discover all form fields in the loaded PDF.
   *
   * @returns An array of FieldInfo objects describing each field.
   * @throws NoFormError if no document has been loaded or the PDF has no form.
   */
  discoverFields(): FieldInfo[] {
    const form = this.getForm();
    const fields = form.getFields();

    return fields.map((field) => {
      const type = FieldTypeDetector.detect(field);
      const name = field.getName();

      return {
        name,
        type,
        required: false,
        currentValue: this.getCurrentValue(field, type),
        options: this.getFieldOptionsFromField(field, type),
        readOnly: field.isReadOnly(),
      };
    });
  }

  /**
   * Get the type of a specific field by name.
   *
   * @param fieldName - The PDF field name.
   * @returns The field type, or null if the field does not exist.
   */
  getFieldType(fieldName: string): PdfFieldType | null {
    const form = this.getForm();
    try {
      const field = form.getField(fieldName);
      return FieldTypeDetector.detect(field);
    } catch {
      return null;
    }
  }

  /**
   * Get the available options for a radio/dropdown field.
   *
   * @param fieldName - The PDF field name.
   * @returns An array of option strings, or null if not applicable.
   */
  getFieldOptions(fieldName: string): string[] | null {
    const form = this.getForm();
    try {
      const field = form.getField(fieldName);
      const type = FieldTypeDetector.detect(field);
      return this.getFieldOptionsFromField(field, type);
    } catch {
      return null;
    }
  }

  setPageHints(mapping: FieldMappingEntry[]): void {
    this.pageHints.clear();

    for (const entry of mapping) {
      let pageIndex: number | undefined;

      if (typeof entry.pageIndex === 'number') {
        pageIndex = entry.pageIndex;
      } else if (typeof entry.pageNumber === 'number') {
        pageIndex = entry.pageNumber - 1;
      }

      if (pageIndex !== undefined && Number.isFinite(pageIndex)) {
        this.pageHints.set(entry.pdfField, Math.trunc(pageIndex));
      }
    }
  }

  /**
   * Set a text field value.
   *
   * @param fieldName - The PDF field name.
   * @param value - The text value to set.
   * @throws FieldNotFoundError if the field does not exist.
   */
  setTextField(fieldName: string, value: string): void {
    const form = this.getForm();
    let field: PDFTextField;
    try {
      field = form.getTextField(fieldName);
    } catch {
      throw new FieldNotFoundError(fieldName);
    }
    const maxLength = field.getMaxLength();
    if (maxLength !== undefined && value.length > maxLength) {
      field.setText(value.slice(0, maxLength));
    } else {
      field.setText(value);
    }
  }

  /**
   * Check or uncheck a checkbox.
   *
   * @param fieldName - The PDF field name.
   * @param checked - Whether to check or uncheck.
   * @throws FieldNotFoundError if the field does not exist.
   */
  setCheckbox(fieldName: string, checked: boolean): void {
    const form = this.getForm();
    try {
      const field = form.getCheckBox(fieldName);
      if (checked) {
        field.check();
      } else {
        field.uncheck();
      }
    } catch (error) {
      if (error instanceof FieldNotFoundError) throw error;
      throw new FieldNotFoundError(fieldName);
    }
  }

  /**
   * Select a radio group option.
   *
   * @param fieldName - The PDF field name.
   * @param optionValue - The option value to select.
   * @throws FieldNotFoundError if the field does not exist.
   */
  setRadioGroup(fieldName: string, optionValue: string): void {
    const form = this.getForm();
    try {
      const field = form.getRadioGroup(fieldName);
      field.select(optionValue);
    } catch (error) {
      if (error instanceof FieldNotFoundError) throw error;
      throw new FieldNotFoundError(fieldName);
    }
  }

  /**
   * Select a dropdown option.
   *
   * @param fieldName - The PDF field name.
   * @param optionValue - The option value to select.
   * @throws FieldNotFoundError if the field does not exist.
   */
  setDropdown(fieldName: string, optionValue: string): void {
    const form = this.getForm();
    try {
      const field = form.getDropdown(fieldName);
      field.select(optionValue);
    } catch (error) {
      if (error instanceof FieldNotFoundError) throw error;
      throw new FieldNotFoundError(fieldName);
    }
  }

  private repairWidgetPageReferences(): void {
    if (!this.pdfDoc || !this.form) {
      return;
    }

    const pages = this.pdfDoc.getPages();

    if (pages.length === 0) {
      return;
    }

    for (const field of this.form.getFields()) {
      const fieldName = field.getName();

      const hintedPageIndex = this.pageHints.get(fieldName);

      // If no page hint is provided, fallback to page 1 only for widgets
      // that have no /P reference. This prevents flatten() from crashing
      // on blank orphan widgets.
      const targetPageIndex = hintedPageIndex ?? 0;
      const safePageIndex = Math.min(
        Math.max(targetPageIndex, 0),
        pages.length - 1,
      );

      const targetPage = pages[safePageIndex];

      const acroField = (field as any).acroField;
      const widgets = acroField?.getWidgets?.() ?? [];

      for (const widget of widgets) {
        const existingPageRef =
          typeof widget.P === 'function' ? widget.P() : undefined;

        // If the user gave a page hint, force it.
        // Otherwise, only repair widgets that have no page reference.
        if (hintedPageIndex !== undefined || !existingPageRef) {
          widget.dict.set(PDFName.of('P'), targetPage.ref);
        }
      }
    }
  }

  async burnMappedValuesOntoPageWidgets(
    mapping: Array<{ dataKey: string; pdfField: string }>,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.pdfDoc) {
      throw new PdfLoadError('No document loaded');
    }

    if (!this.options.flattenPdf || this.options.flattenStrategy !== 'pageWidgets') {
      return;
    }

    const font = await this.pdfDoc.embedFont(StandardFonts.Helvetica);
    const valuesByPdfField = new Map<string, string>();

    for (const entry of mapping) {
      const value = this.getValueByPath(data, entry.dataKey);

      if (value === undefined || value === null || value === '') {
        continue;
      }

      valuesByPdfField.set(entry.pdfField, String(value));
    }

    for (const page of this.pdfDoc.getPages()) {
      const annots = (page.node as any).Annots?.();

      if (!annots || typeof annots.size !== 'function') {
        continue;
      }

      for (let i = 0; i < annots.size(); i++) {
        const annotRef = annots.get(i);
        const annot = this.pdfDoc.context.lookup(annotRef) as PDFDict | undefined;

        if (!annot) {
          continue;
        }

        const subtype = annot.get(PDFName.of('Subtype'));

        if (String(subtype) !== '/Widget') {
          continue;
        }

        const rect = this.lookupOptionalArray(annot.get(PDFName.of('Rect')));
        const coords = this.readRect(rect);

        if (!coords) {
          continue;
        }

        const [x0, y0, x1, y1] = coords;
        const width = x1 - x0;
        const height = y1 - y0;

        if (width <= 0 || height <= 0) {
          continue;
        }

        // Recrée visuellement les zones grises du CERFA en dur dans la page
        page.drawRectangle({
          x: x0,
          y: y0,
          width,
          height,
          color: rgb(0.82, 0.84, 0.88),
        });

        const fieldName = this.decodePdfText(annot.get(PDFName.of('T')));

        if (!fieldName) {
          continue;
        }

        const value = valuesByPdfField.get(fieldName);

        if (!value) {
          continue;
        }

        const fieldType = String(annot.get(PDFName.of('FT')));

        if (fieldType === '/Btn') {
          const normalized = value.toLowerCase();

          if (['true', '1', 'yes', 'oui', 'x'].includes(normalized)) {
            page.drawText('X', {
              x: x0 + 1.5,
              y: y0 + 1,
              size: Math.max(6, Math.min(9, height * 0.8)),
              font,
              color: rgb(0, 0, 0),
            });
          }

          continue;
        }

        const size = Math.max(6, Math.min(8, height * 0.72));

        page.drawText(value, {
          x: x0 + 2,
          y: y0 + Math.max(1.5, (height - size) / 2),
          size,
          font,
          color: rgb(0, 0, 0),
          maxWidth: Math.max(1, width - 4),
        });
      }
    }

    this.pageWidgetsBurned = true;
  }

  private lookupOptionalDict(value: any): PDFDict | undefined {
    if (!this.pdfDoc || !value) {
      return undefined;
    }

    try {
      if (value instanceof PDFDict) {
        return value;
      }

      const lookedUp = this.pdfDoc.context.lookup(value);

      if (lookedUp instanceof PDFDict) {
        return lookedUp;
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private lookupOptionalArray(value: any): PDFArray | undefined {
    if (!this.pdfDoc || !value) {
      return undefined;
    }

    try {
      if (value instanceof PDFArray) {
        return value;
      }

      const lookedUp = this.pdfDoc.context.lookup(value);

      if (lookedUp instanceof PDFArray) {
        return lookedUp;
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private toPdfBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    const normalized = String(value ?? '')
      .trim()
      .toLowerCase();

    return [
      'true',
      '1',
      'yes',
      'oui',
      'on',
      'checked',
      'check',
      'x',
    ].includes(normalized);
  }

  private getWidgetOnStateName(annot: PDFDict): PDFName | undefined {
    const ap = this.lookupOptionalDict(annot.get(PDFName.of('AP')));

    if (!ap) {
      return undefined;
    }

    const normalAppearance = this.lookupOptionalDict(ap.get(PDFName.of('N')));

    if (!normalAppearance) {
      return undefined;
    }

    const entries = normalAppearance.entries();

    for (const [key] of entries) {
      if (String(key) !== '/Off') {
        return key as PDFName;
      }
    }

    return undefined;
  }

  private getValueByPath(data: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => {
      if (
        current &&
        typeof current === 'object' &&
        key in current
      ) {
        return (current as Record<string, unknown>)[key];
      }

      return undefined;
    }, data);
  }

  private decodePdfText(value: any): string | undefined {
    if (!value) {
      return undefined;
    }

    if (typeof value.decodeText === 'function') {
      return value.decodeText();
    }

    if (typeof value.asString === 'function') {
      return value.asString();
    }

    if (typeof value.value === 'function') {
      return value.value();
    }

    if (typeof value.value === 'string') {
      return value.value;
    }

    return String(value).replace(/^\((.*)\)$/, '$1');
  }

  private readRect(rect: PDFArray | undefined): [number, number, number, number] | undefined {
    if (!rect || typeof rect.size !== 'function' || rect.size() < 4) {
      return undefined;
    }

    const values: number[] = [];

    for (let i = 0; i < 4; i++) {
      const item = rect.lookup(i) as any;

      if (item && typeof item.asNumber === 'function') {
        values.push(item.asNumber());
      } else {
        values.push(Number(item));
      }
    }

    if (values.some((value) => !Number.isFinite(value))) {
      return undefined;
    }

    return values as [number, number, number, number];
  }

  private removeWidgetAnnotationsAndAcroForm(): void {
    if (!this.pdfDoc) {
      return;
    }

    for (const page of this.pdfDoc.getPages()) {
      const annots = (page.node as any).Annots?.();

      if (!annots || typeof annots.size !== 'function') {
        continue;
      }

      const keptAnnots = [];

      for (let i = 0; i < annots.size(); i++) {
        const annotRef = annots.get(i);
        const annot = this.pdfDoc.context.lookup(annotRef) as PDFDict | undefined;

        if (!annot) {
          continue;
        }

        const subtype = annot.get(PDFName.of('Subtype'));

        if (String(subtype) !== '/Widget') {
          keptAnnots.push(annotRef);
        }
      }

      if (keptAnnots.length === 0) {
        page.node.delete(PDFName.of('Annots'));
      } else {
        page.node.set(
          PDFName.of('Annots'),
          this.pdfDoc.context.obj(keptAnnots),
        );
      }
    }

    this.pdfDoc.catalog.delete(PDFName.of('AcroForm'));
  }

  async fillEditablePageWidgets(
    mapping: Array<{ dataKey: string; pdfField: string }>,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.pdfDoc || !this.options.editablePageWidgets) {
      return;
    }

    const font = await this.pdfDoc.embedFont(StandardFonts.Helvetica);
    const valuesByPdfField = new Map<string, string>();

    for (const entry of mapping) {
      const value = this.getValueByPath(data, entry.dataKey);

      if (value === undefined || value === null || value === '') {
        continue;
      }

      valuesByPdfField.set(entry.pdfField, String(value));
    }

    for (const page of this.pdfDoc.getPages()) {
      const annots = (page.node as any).Annots?.();

      if (!annots || typeof annots.size !== 'function') {
        continue;
      }

      for (let i = 0; i < annots.size(); i++) {
        const annotRef = annots.get(i);
        const annot = this.pdfDoc.context.lookup(annotRef) as PDFDict | undefined;

        if (!annot) {
          continue;
        }

        const subtype = annot.get(PDFName.of('Subtype'));

        if (String(subtype) !== '/Widget') {
          continue;
        }

        const parent = this.lookupOptionalDict(annot.get(PDFName.of('Parent')));

        const fieldName =
          this.decodePdfText(annot.get(PDFName.of('T'))) ||
          this.decodePdfText(parent?.get(PDFName.of('T')));

        if (!fieldName) {
          continue;
        }

        const value = valuesByPdfField.get(fieldName);

        if (!value) {
          continue;
        }

        const rect = this.lookupOptionalArray(annot.get(PDFName.of('Rect')));
        const coords = this.readRect(rect);

        if (!coords) {
          continue;
        }

        const [x0, y0, x1, y1] = coords;
        const width = x1 - x0;
        const height = y1 - y0;

        if (width <= 0 || height <= 0) {
          continue;
        }

        const fieldType = String(
          annot.get(PDFName.of('FT')) ??
          parent?.get(PDFName.of('FT')),
        );

        if (fieldType === '/Btn') {
          const checked = this.toPdfBoolean(value);
          const fieldDict = parent ?? annot;

          const onStateName = this.getWidgetOnStateName(annot) ?? PDFName.of('Yes');
          const offStateName = PDFName.of('Off');

          if (checked) {
            fieldDict.set(PDFName.of('V'), onStateName);
            annot.set(PDFName.of('AS'), onStateName);
          } else {
            fieldDict.set(PDFName.of('V'), offStateName);
            annot.set(PDFName.of('AS'), offStateName);
          }

          continue;
        }

        const pdfValue = PDFString.of(value);

        // Valeur du champ
        annot.set(PDFName.of('V'), pdfValue);

        if (parent) {
          parent.set(PDFName.of('V'), pdfValue);
        }

        // Apparence visible du champ
        const appearanceRef = this.createTextWidgetAppearance(value, width, height, font);

        annot.set(
          PDFName.of('AP'),
          this.pdfDoc.context.obj({
            N: appearanceRef,
          }),
        );

        // Apparence par défaut : Helvetica noir
        const da = PDFString.of('/Helv 8 Tf 0 g');
        annot.set(PDFName.of('DA'), da);

        if (parent) {
          parent.set(PDFName.of('DA'), da);
        }
      }
    }
  }

  private createTextWidgetAppearance(
    value: string,
    width: number,
    height: number,
    font: any,
  ) {
    const fontSize = Math.max(6, Math.min(8, height * 0.72));
    const y = Math.max(1.5, (height - fontSize) / 2);
    const encodedText = font.encodeText(value).toString();

    const content = [
      'q',
      '0.82 0.84 0.88 rg',
      `0 0 ${width.toFixed(2)} ${height.toFixed(2)} re f`,
      'BT',
      '0 g',
      `/Helv ${fontSize.toFixed(2)} Tf`,
      `2 ${y.toFixed(2)} Td`,
      `${encodedText} Tj`,
      'ET',
      'Q',
    ].join('\n');

    const appearance = this.pdfDoc!.context.flateStream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, width, height],
      Resources: {
        Font: {
          Helv: font.ref,
        },
      },
    });

    return this.pdfDoc!.context.register(appearance);
  }

  /**
   * Save the document and return the PDF bytes.
   *
   * @returns The filled PDF as a Uint8Array.
   */
  async saveDocument(): Promise<Uint8Array> {
    if (!this.pdfDoc) {
      throw new PdfLoadError('No document loaded');
    }

    const form = this.form;

    if (form) {
      if (this.options.flattenPdf) {
        if (this.options.flattenStrategy === 'pdfLib') {
          form.flatten({ updateFieldAppearances: true });
        } else if (this.pageWidgetsBurned) {
          this.removeWidgetAnnotationsAndAcroForm();
        }
      } else if (!this.options.editablePageWidgets) {
        try {
          form.updateFieldAppearances();
        } catch {
          // Non-fatal: some fields may not support appearance updates.
        }
      }
    }

    return this.pdfDoc.save();
  }

  /**
   * Get the currently loaded form, throwing if none is loaded.
   */
  private getForm(): PDFForm {
    if (!this.form) {
      throw new NoFormError();
    }
    return this.form;
  }

  /**
   * Extract the current value of a field based on its type.
   */
  private getCurrentValue(
    field: import('pdf-lib').PDFField,
    type: PdfFieldType,
  ): string | boolean | null {
    try {
      switch (type) {
        case 'text':
          return (field as PDFTextField).getText() ?? null;
        case 'checkbox':
          return (field as PDFCheckBox).isChecked();
        case 'radio':
          return (field as PDFRadioGroup).getSelected() ?? null;
        case 'dropdown':
          return (field as PDFDropdown).getSelected()[0] ?? null;
        case 'optionList':
          return (field as PDFOptionList).getSelected()[0] ?? null;
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Extract available options from a field if it is a radio, dropdown, or optionList.
   */
  private getFieldOptionsFromField(
    field: import('pdf-lib').PDFField,
    type: PdfFieldType,
  ): string[] | null {
    try {
      switch (type) {
        case 'radio':
          return (field as PDFRadioGroup).getOptions();
        case 'dropdown':
          return (field as PDFDropdown).getOptions();
        case 'optionList':
          return (field as PDFOptionList).getOptions();
        default:
          return null;
      }
    } catch {
      return null;
    }
  }
}
