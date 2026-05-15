import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { PdfFormFillerEngine } from '../../src/engine/PdfFormFillerEngine';
import { PdfLibAdapter } from '../../src/adapter/PdfLibAdapter';
import {
	PdfLoadError,
	NoFormError,
	InvalidMappingError,
} from '../../src/errors/PdfFormFillerError';
import type { FieldMappingEntry } from '../../src/types';

export class PdfFormFiller implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'PDF Form Filler Flat',
		name: 'pdfFormFillerFlat',
		icon: 'file:pdf-form-filler.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description: 'Fill and flatten AcroForm PDF fields with JSON data',
		defaults: {
			name: 'PDF Form Filler Flat',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Discover Fields',
						value: 'discoverFields',
						description: 'List all form fields in the PDF',
						action: 'Discover form fields in a PDF',
					},
					{
						name: 'Fill Form',
						value: 'fillForm',
						description: 'Fill PDF form fields with data',
						action: 'Fill form fields in a PDF',
					},
				],
				default: 'discoverFields',
			},
			{
				displayName: 'PDF Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				description: 'Name of the binary property containing the PDF file',
			},
			// --- Fill Form parameters (Phase 6) ---
			{
				displayName: 'Mapping Source',
				name: 'mappingSource',
				type: 'options',
				options: [
					{
						name: 'Static (Configure Below)',
						value: 'static',
						description: 'Define field mappings in the node UI',
					},
					{
						name: 'Dynamic (From Input)',
						value: 'dynamic',
						description: 'Read field mappings from the input item JSON',
					},
				],
				default: 'static',
				displayOptions: {
					show: {
						operation: ['fillForm'],
					},
				},
				description: 'Where to read the field mapping from',
			},
			{
				displayName: 'Field Mappings',
				name: 'fieldMappings',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					sortable: true,
				},
				default: {},
				displayOptions: {
					show: {
						operation: ['fillForm'],
						mappingSource: ['static'],
					},
				},
				options: [
					{
						name: 'entries',
						displayName: 'Mapping Entry',
						values: [
							{
								displayName: 'Data Key',
								name: 'dataKey',
								type: 'string',
								default: '',
								placeholder: 'e.g. applicant.firstName',
								description: 'Dot-notation path into the data payload',
								required: true,
							},
							{
								displayName: 'PDF Field',
								name: 'pdfField',
								type: 'string',
								default: '',
								placeholder: 'e.g. A1-First name',
								description: 'Exact PDF form field name',
								required: true,
							},
							{
								displayName: 'Date Format',
								name: 'dateFormat',
								type: 'string',
								default: '',
								placeholder: 'e.g. DD/MM/YYYY',
								description:
									'Optional date format override for this field. Tokens: DD, D, MM, M, YYYY, YY.',
							},
						],
					},
				],
				description: 'Map data keys to PDF form field names',
			},
			{
				displayName: 'Dynamic Mapping Property',
				name: 'dynamicMappingProperty',
				type: 'string',
				default: 'fieldMappings',
				displayOptions: {
					show: {
						operation: ['fillForm'],
						mappingSource: ['dynamic'],
					},
				},
				description:
					'Name of the JSON property on the input item containing the mapping array',
			},
			{
				displayName: 'Output Binary Property',
				name: 'outputBinaryProperty',
				type: 'string',
				default: 'data',
				displayOptions: {
					show: {
						operation: ['fillForm'],
					},
				},
				description: 'Name of the binary property for the filled PDF output',
			},
			{
				displayName: 'Output File Name',
				name: 'outputFileName',
				type: 'string',
				default: 'filled-form.pdf',
				displayOptions: {
					show: {
						operation: ['fillForm'],
					},
				},
				description: 'Filename for the output PDF binary',
			},
			{
				displayName: 'Warn on Missing Values',
				name: 'warnOnMissingValues',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						operation: ['fillForm'],
					},
				},
				description:
					'Whether to emit warnings for mapped fields that have no corresponding value in the data payload',
			},
			{
				displayName: 'Default Date Format',
				name: 'defaultDateFormat',
				type: 'string',
				default: 'DD/MM/YYYY',
				displayOptions: {
					show: {
						operation: ['fillForm'],
					},
				},
				description:
					'Global default date format for ISO date strings. Tokens: DD, D, MM, M, YYYY, YY.',
			},
			{
				displayName: 'Flatten PDF',
				name: 'flattenPdf',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
					operation: ['fillForm'],
					},
				},
				description: 'Whether to flatten form fields into visible page content after filling',
			},
			{
				displayName: 'Editable Page Widgets',
				name: 'editablePageWidgets',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
					operation: ['fillForm'],
					flattenPdf: [false],
					},
				},
				description: 'Fill visible page widget annotations and generate appearances while keeping fields editable',
			},
			{
				displayName: 'Flatten Strategy',
				name: 'flattenStrategy',
				type: 'options',
				default: 'pageWidgets',
				options: [
					{
					name: 'Burn Values Onto Page Widgets',
					value: 'pageWidgets',
					description: 'Draw values directly onto page widget positions and remove form annotations',
					},
					{
					name: 'PDF-lib Form Flatten',
					value: 'pdfLib',
					description: 'Use pdf-lib form.flatten()',
					},
				],
				displayOptions: {
					show: {
					operation: ['fillForm'],
					flattenPdf: [true],
					},
				},
			}
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const binaryPropertyName = this.getNodeParameter(
					'binaryPropertyName',
					itemIndex,
				) as string;

				// Validate binary data exists
				this.helpers.assertBinaryData(itemIndex, binaryPropertyName);
				const pdfBuffer = await this.helpers.getBinaryDataBuffer(
					itemIndex,
					binaryPropertyName,
				);
				const pdfBytes = new Uint8Array(pdfBuffer);

				if (operation === 'discoverFields') {
					const adapter = new PdfLibAdapter();
					const engine = new PdfFormFillerEngine(adapter);

					this.logger.debug('Discovering fields in PDF', { itemIndex });
					const fields = await engine.discoverFields(pdfBytes);
					this.logger.info(`Discovered ${fields.length} form fields`, { itemIndex });

					// Return fields as JSON with original binary passed through
					const newItem: INodeExecutionData = {
						json: {
							fields,
							fieldCount: fields.length,
						},
						binary: items[itemIndex].binary,
						pairedItem: { item: itemIndex },
					};

					returnData.push(newItem);
				} else if (operation === 'fillForm') {
					// Read options
					const warnOnMissingValues = this.getNodeParameter(
						'warnOnMissingValues',
						itemIndex,
					) as boolean;
					const defaultDateFormat = this.getNodeParameter(
						'defaultDateFormat',
						itemIndex,
					) as string;
					const outputBinaryProperty = this.getNodeParameter(
						'outputBinaryProperty',
						itemIndex,
					) as string;
					const outputFileName = this.getNodeParameter(
						'outputFileName',
						itemIndex,
					) as string;
					const flattenPdf = this.getNodeParameter(
						'flattenPdf',
						itemIndex,
						false,
					) as boolean;
					
					const editablePageWidgets = this.getNodeParameter(
						'editablePageWidgets',
						itemIndex,
						false,
					) as boolean;

					const flattenStrategy = this.getNodeParameter(
						'flattenStrategy',
						itemIndex,
						'pageWidgets',
					) as 'pageWidgets' | 'pdfLib';

					// Resolve mapping
					const mappingSource = this.getNodeParameter(
						'mappingSource',
						itemIndex,
					) as string;

					let mapping: FieldMappingEntry[];

					if (mappingSource === 'dynamic') {
						const dynamicMappingProperty = this.getNodeParameter(
							'dynamicMappingProperty',
							itemIndex,
						) as string;

						const dynamicMapping = items[itemIndex].json[dynamicMappingProperty];
						if (!Array.isArray(dynamicMapping)) {
							throw new NodeOperationError(
								this.getNode(),
								`Dynamic mapping property '${dynamicMappingProperty}' is not an array`,
								{
									description: `Expected an array of mapping entries at item.json.${dynamicMappingProperty}`,
									itemIndex,
								},
							);
						}
						mapping = dynamicMapping as FieldMappingEntry[];
					} else {
						// Static mapping from fixedCollection
						const fieldMappingsRaw = this.getNodeParameter(
							'fieldMappings',
							itemIndex,
							{},
						) as { entries?: Array<{ dataKey: string; pdfField: string; dateFormat?: string }> };

						const entries = fieldMappingsRaw.entries ?? [];
						mapping = entries.map((entry) => ({
							dataKey: entry.dataKey,
							pdfField: entry.pdfField,
							dateFormat: entry.dateFormat || undefined,
						}));
					}

					// Use the input item's JSON as the data payload
					const data = items[itemIndex].json as Record<string, unknown>;

					// Fill the form
					const adapter = new PdfLibAdapter({
						flattenPdf,
						flattenStrategy,
						editablePageWidgets,
					});
					const engine = new PdfFormFillerEngine(adapter, {
						warnOnMissingValues,
						defaultDateFormat,
					});

					this.logger.debug('Filling form', {
						itemIndex,
						mappingCount: mapping.length,
						mappingSource,
					});

					const result = await engine.fillForm(pdfBytes, mapping, data);

					this.logger.info(
						`Fill complete: ${result.fieldsFilled} filled, ${result.fieldsMissing} missing, ${result.fieldsSkipped} skipped, ${result.fieldsErrored} errored`,
						{ itemIndex, status: result.status },
					);

					// Surface warnings as execution hints so they're visible in the n8n UI
					if (result.warnings.length > 0) {
						const warningMessage =
							result.warnings.length === 1
								? result.warnings[0]
								: `${result.warnings.length} warnings:\n${result.warnings.map((w) => `  - ${w}`).join('\n')}`;

						this.addExecutionHints({
							message: warningMessage,
							type: result.status === 'error' ? 'danger' : 'warning',
							location: 'outputPane',
						});
					}

					// Log individual warnings at debug level for server-side troubleshooting
					for (const warning of result.warnings) {
						this.logger.warn(warning, { itemIndex });
					}

					// Prepare the filled PDF as binary data
					const filledBuffer = Buffer.from(result.pdfBytes);
					const binaryData = await this.helpers.prepareBinaryData(
						filledBuffer,
						outputFileName,
						'application/pdf',
					);

					const newItem: INodeExecutionData = {
						json: {
							status: result.status,
							fieldsFilled: result.fieldsFilled,
							fieldsMissing: result.fieldsMissing,
							fieldsSkipped: result.fieldsSkipped,
							fieldsErrored: result.fieldsErrored,
							warnings: result.warnings,
							fileName: outputFileName,
						},
						binary: {
							[outputBinaryProperty]: binaryData,
						},
						pairedItem: { item: itemIndex },
					};

					returnData.push(newItem);
				}
			} catch (error) {
				if (error instanceof PdfLoadError) {
					throw new NodeOperationError(this.getNode(), error.message, {
						description: 'Check that the input is a valid AcroForm PDF.',
						itemIndex,
					});
				}
				if (error instanceof NoFormError) {
					throw new NodeOperationError(this.getNode(), error.message, {
						description:
							'This PDF does not contain any fillable form fields. Only AcroForm PDFs are supported.',
						itemIndex,
					});
				}
				if (error instanceof InvalidMappingError) {
					throw new NodeOperationError(this.getNode(), error.message, {
						description:
							'Check that the field mapping is correctly configured with valid dataKey and pdfField values.',
						itemIndex,
					});
				}
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
