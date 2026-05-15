import {
  EngineOptions,
  FieldInfo,
  FieldMappingEntry,
  FieldFillResult,
  FillFormResult,
  IPdfAdapter,
} from '../types';
import { InvalidMappingError } from '../errors/PdfFormFillerError';
import { MappingResolver } from './MappingResolver';
import { ValueCoercer } from './ValueCoercer';

/**
 * Central orchestrator for PDF form filling.
 *
 * Pure TypeScript class with no n8n dependencies. Coordinates between
 * the MappingResolver (data extraction), ValueCoercer (type conversion),
 * and IPdfAdapter (PDF operations).
 */
export class PdfFormFillerEngine {
  private readonly warnOnMissingValues: boolean;
  private readonly defaultDateFormat: string;

  /**
   * @param adapter - The PDF adapter implementation (e.g. PdfLibAdapter).
   * @param options - Engine configuration options.
   */
  constructor(
    private readonly adapter: IPdfAdapter,
    options: EngineOptions = {},
  ) {
    this.warnOnMissingValues = options.warnOnMissingValues ?? true;
    this.defaultDateFormat = options.defaultDateFormat ?? 'DD/MM/YYYY';
  }

  /**
   * Discover all form fields in the loaded PDF.
   *
   * @param pdfBytes - The raw PDF file bytes.
   * @returns An array of FieldInfo objects describing each field.
   */
  async discoverFields(pdfBytes: Uint8Array): Promise<FieldInfo[]> {
    await this.adapter.loadDocument(pdfBytes);
    return this.adapter.discoverFields();
  }

  /**
   * Fill the PDF using a mapping and data payload.
   *
   * For each mapping entry, resolves the data value via dot-notation,
   * coerces it to the target field type, and writes it to the PDF.
   * Per-field errors are collected as warnings; structural errors abort.
   *
   * @param pdfBytes - The raw PDF template bytes.
   * @param mapping - Array of field mapping entries.
   * @param data - The data payload to fill from.
   * @returns The filled PDF bytes and a summary of the operation.
   */
  async fillForm(
    pdfBytes: Uint8Array,
    mapping: FieldMappingEntry[],
    data: Record<string, unknown>,
  ): Promise<FillFormResult> {
    this.validateMapping(mapping);
    await this.adapter.loadDocument(pdfBytes);
    const adapterWithPageHints = this.adapter as IPdfAdapter & {
      setPageHints?: (mapping: FieldMappingEntry[]) => void;
    };

    adapterWithPageHints.setPageHints?.(mapping);

    const details: FieldFillResult[] = [];
    const warnings: string[] = [];

    for (const entry of mapping) {
      const result = this.processEntry(entry, data);
      details.push(result);

      if (result.message) {
        warnings.push(result.message);
      }
    }

    const adapterWithPageBurn = this.adapter as IPdfAdapter & {
      burnMappedValuesOntoPageWidgets?: (
        mapping: FieldMappingEntry[],
        data: Record<string, unknown>,
      ) => Promise<void>;
    };

    await adapterWithPageBurn.burnMappedValuesOntoPageWidgets?.(mapping, data);

    const adapterWithEditableWidgets = this.adapter as IPdfAdapter & {
      fillEditablePageWidgets?: (
        mapping: FieldMappingEntry[],
        data: Record<string, unknown>,
      ) => Promise<void>;
    };

    await adapterWithEditableWidgets.fillEditablePageWidgets?.(mapping, data);

    const pdfResultBytes = await this.adapter.saveDocument();

    const fieldsFilled = details.filter((d) => d.status === 'filled').length;
    const fieldsMissing = details.filter((d) => d.status === 'missing').length;
    const fieldsSkipped = details.filter((d) => d.status === 'skipped').length;
    const fieldsErrored = details.filter((d) => d.status === 'error').length;

    let status: FillFormResult['status'] = 'success';
    if (fieldsErrored > 0 && fieldsFilled === 0) {
      status = 'error';
    } else if (fieldsErrored > 0 || fieldsSkipped > 0) {
      status = 'partial';
    }

    return {
      pdfBytes: pdfResultBytes,
      status,
      fieldsFilled,
      fieldsMissing,
      fieldsSkipped,
      fieldsErrored,
      warnings,
      details,
    };
  }

  /**
   * Validate the mapping array structure.
   *
   * @param mapping - The mapping to validate.
   * @throws InvalidMappingError if the mapping is malformed.
   */
  private validateMapping(mapping: FieldMappingEntry[]): void {
    if (!Array.isArray(mapping)) {
      throw new InvalidMappingError('Mapping must be an array');
    }

    for (let i = 0; i < mapping.length; i++) {
      const entry = mapping[i];
      if (!entry.dataKey || typeof entry.dataKey !== 'string') {
        throw new InvalidMappingError(
          `Entry ${i}: 'dataKey' is required and must be a string`,
        );
      }
      if (!entry.pdfField || typeof entry.pdfField !== 'string') {
        throw new InvalidMappingError(
          `Entry ${i}: 'pdfField' is required and must be a string`,
        );
      }
    }
  }

  /**
   * Process a single mapping entry: resolve value, coerce, and set on the PDF.
   *
   * @param entry - The mapping entry to process.
   * @param data - The data payload.
   * @returns A FieldFillResult describing the outcome.
   */
  private processEntry(
    entry: FieldMappingEntry,
    data: Record<string, unknown>,
  ): FieldFillResult {
    const { dataKey, pdfField } = entry;

    // Step 1: Check the field exists in the PDF
    const fieldType = this.adapter.getFieldType(pdfField);
    if (fieldType === null) {
      return {
        pdfField,
        dataKey,
        status: 'error',
        message: `PDF field '${pdfField}' not found in the document`,
      };
    }

    // Step 2: Resolve the value from the data payload
    const rawValue = MappingResolver.resolve(data, dataKey);
    if (rawValue === undefined) {
      const message = this.warnOnMissingValues
        ? `Mapped field '${dataKey}' has no value in data payload`
        : undefined;
      return { pdfField, dataKey, status: 'missing', message };
    }

    // Step 3: Coerce the value
    const dateFormat = entry.dateFormat ?? this.defaultDateFormat;
    const fieldOptions = this.adapter.getFieldOptions(pdfField) ?? undefined;
    const coercionResult = ValueCoercer.coerce(rawValue, fieldType, {
      dateFormat,
      fieldOptions,
    });

    if (!coercionResult.success) {
      return {
        pdfField,
        dataKey,
        status: 'skipped',
        message: coercionResult.warning,
      };
    }

    // Step 4: Set the value on the PDF field
    try {
      this.setFieldValue(pdfField, fieldType, coercionResult.value!);
      return { pdfField, dataKey, status: 'filled' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { pdfField, dataKey, status: 'error', message };
    }
  }

  /**
   * Dispatch a coerced value to the appropriate adapter setter method.
   *
   * @param fieldName - The PDF field name.
   * @param fieldType - The field type.
   * @param value - The coerced value.
   */
  private setFieldValue(
    fieldName: string,
    fieldType: string,
    value: string | boolean,
  ): void {
    switch (fieldType) {
      case 'text':
        this.adapter.setTextField(fieldName, value as string);
        break;
      case 'checkbox':
        this.adapter.setCheckbox(fieldName, value as boolean);
        break;
      case 'radio':
        this.adapter.setRadioGroup(fieldName, value as string);
        break;
      case 'dropdown':
      case 'optionList':
        this.adapter.setDropdown(fieldName, value as string);
        break;
    }
  }
}
