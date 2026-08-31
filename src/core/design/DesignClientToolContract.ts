import type { DesignBrowserToolResult } from './AgentBrowserRuntime';

export const INSPECT_DESIGN_TOOL_NAME = 'inspect_design';
export const DESIGN_TOOL_MAX_TEXT_BYTES = 32 * 1024;
export const DESIGN_TOOL_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface DesignClientToolDefinition {
  name: typeof INSPECT_DESIGN_TOOL_NAME;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DesignClientToolTextContent {
  type: 'text';
  text: string;
}

export interface DesignClientToolImageContent {
  type: 'image';
  data: string;
  mimeType: 'image/png';
}

export type DesignClientToolContent =
  | DesignClientToolTextContent
  | DesignClientToolImageContent;

export const INSPECT_DESIGN_TOOL_DEFINITION: DesignClientToolDefinition = {
  name: INSPECT_DESIGN_TOOL_NAME,
  description:
    'Open and inspect the exact current Design candidate. Use only the operations needed for this change.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['operation'],
    properties: {
      operation: {
        type: 'string',
        description:
          'Choose one bridge operation. Browser actions use operation "act" plus an action.',
        enum: [
          'open_candidate',
          'observe',
          'act',
          'set_viewport',
          'set_media',
          'screenshot',
          'accessibility'
        ]
      },
      action: {
        type: 'string',
        description: 'Required only when operation is "act".',
        enum: [
          'click',
          'double_click',
          'hover',
          'focus',
          'fill',
          'type',
          'key',
          'select',
          'check',
          'uncheck',
          'scroll',
          'scroll_into_view',
          'drag',
          'wait'
        ]
      },
      ref: {
        type: 'string',
        description: 'A current snapshot reference including its @ prefix, for example @e4.',
        pattern: '^@e[1-9][0-9]{0,4}$'
      },
      targetRef: {
        type: 'string',
        description: 'A second current snapshot reference including its @ prefix.',
        pattern: '^@e[1-9][0-9]{0,4}$'
      },
      value: { type: 'string', maxLength: 4096 },
      values: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: { type: 'string', maxLength: 4096 }
      },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'integer', minimum: 1, maximum: 2000 },
      milliseconds: { type: 'integer', minimum: 0, maximum: 2000 },
      width: {
        type: 'integer',
        description: 'Required only for set_viewport.',
        minimum: 320,
        maximum: 2560
      },
      height: {
        type: 'integer',
        description: 'Required only for set_viewport.',
        minimum: 320,
        maximum: 2000
      },
      colorScheme: {
        type: 'string',
        enum: ['light', 'dark']
      },
      reducedMotion: { type: 'boolean' },
      fullPage: { type: 'boolean' }
    },
    oneOf: [
      {
        title: 'Open the exact current candidate',
        properties: { operation: { const: 'open_candidate' } },
        required: ['operation']
      },
      {
        title: 'Refresh the snapshot, console, and runtime errors',
        properties: { operation: { const: 'observe' } },
        required: ['operation']
      },
      {
        title: 'Perform one browser action, then observe',
        properties: {
          operation: { const: 'act' }
        },
        required: ['operation', 'action']
      },
      {
        title: 'Set the viewport, then observe',
        properties: {
          operation: { const: 'set_viewport' }
        },
        required: ['operation', 'width', 'height']
      },
      {
        title: 'Set color and motion media, then observe',
        properties: {
          operation: { const: 'set_media' }
        },
        required: ['operation', 'colorScheme', 'reducedMotion']
      },
      {
        title: 'Capture a transient screenshot',
        properties: { operation: { const: 'screenshot' } },
        required: ['operation']
      },
      {
        title: 'Run the bounded accessibility audit',
        properties: { operation: { const: 'accessibility' } },
        required: ['operation']
      }
    ]
  }
};

export function designClientToolContent(
  result: DesignBrowserToolResult
): DesignClientToolContent[] {
  if (Buffer.byteLength(result.text, 'utf8') > DESIGN_TOOL_MAX_TEXT_BYTES) {
    throw new Error('The Design browser text result is too large.');
  }
  if (!result.image) return [{ type: 'text', text: result.text }];
  if (
    result.image.mimeType !== 'image/png' ||
    result.image.bytes.byteLength > DESIGN_TOOL_MAX_IMAGE_BYTES ||
    !Number.isSafeInteger(result.image.width) ||
    result.image.width <= 0 ||
    !Number.isSafeInteger(result.image.height) ||
    result.image.height <= 0
  ) {
    throw new Error('The Design browser image result is invalid.');
  }
  return [
    { type: 'text', text: result.text },
    {
      type: 'image',
      data: result.image.bytes.toString('base64'),
      mimeType: result.image.mimeType
    }
  ];
}

export function safeDesignClientToolFailure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  if (
    message.length > 0 &&
    message.length <= 1_000 &&
    !message.includes('/') &&
    !message.includes('\\')
  ) {
    return message;
  }
  return 'The Design browser operation failed. Correct the source or open a fresh candidate.';
}
