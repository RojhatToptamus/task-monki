import { safeClientToolFailure, type ClientToolDefinition } from '../agent/clientTools/ClientToolContract';

import { INSPECT_DESIGN_TOOL_NAME } from '../../shared/clientTools';

export { INSPECT_DESIGN_TOOL_NAME };

export const INSPECT_DESIGN_TOOL_DEFINITION: ClientToolDefinition = {
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
          'navigate',
          'act',
          'set_viewport',
          'set_media',
          'screenshot',
          'accessibility'
        ]
      },
      path: { type: 'string', description: 'For navigate: an absolute path within the selected application, including optional query and fragment.', maxLength: 2048, pattern: '^/(?!/)' },
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
        title: 'Navigate within the selected application',
        properties: { operation: { const: 'navigate' } },
        required: ['operation', 'path']
      },
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

/** Design failures reach the provider as text; paths never do. */
export function safeDesignClientToolFailure(error: unknown): string {
  return safeClientToolFailure(
    error,
    'The Design browser operation failed. Correct the source or open a fresh candidate.'
  );
}
