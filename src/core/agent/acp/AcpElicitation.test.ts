import { describe, expect, it } from 'vitest';
import {
  mapAcpElicitationResponse,
  mapAcpFormElicitation
} from './AcpElicitation';

describe('ACP form elicitation mapping', () => {
  it('maps the shared AskUserQuestion form shape to native question UI and back', () => {
    const mapped = mapAcpFormElicitation({
      sessionId: 'session-1',
      toolCallId: 'question-tool-1',
      mode: 'form',
      message: 'Which direction should the Design use?',
      requestedSchema: {
        type: 'object',
        properties: {
          question_0: {
            type: 'string',
            title: 'Direction',
            oneOf: [
              {
                const: 'Marketplace',
                title: 'Marketplace',
                description: 'Let visitors browse and order.'
              },
              {
                const: 'Directory',
                title: 'Directory',
                description: 'Focus on vendors, hours, and location.'
              }
            ]
          },
          question_0_custom: {
            type: 'string',
            title: 'Other',
            _meta: {
              _askUserQuestionCustomAnswer: {
                questionId: 'question_0',
                isCustomAnswer: true
              }
            }
          }
        }
      }
    }, 'Claude Agent ACP');

    expect(mapped).toEqual({
      type: 'USER_INPUT',
      request: {
        questions: [
          {
            id: 'question_0',
            header: 'Direction',
            question: 'Which direction should the Design use?',
            isOther: true,
            isSecret: false,
            options: [
              {
                label: 'Marketplace',
                description: 'Let visitors browse and order.'
              },
              {
                label: 'Directory',
                description: 'Focus on vendors, hours, and location.'
              }
            ]
          }
        ]
      }
    });
    expect(
      mapAcpElicitationResponse(mapped.type, mapped.request, {
        interactionType: 'USER_INPUT',
        action: 'ANSWER',
        answers: { question_0: ['Decide for me'] }
      })
    ).toEqual({
      action: 'accept',
      content: { question_0_custom: 'Decide for me' }
    });
  });

  it('keeps unrelated ACP forms on the existing generic elicitation path', () => {
    const mapped = mapAcpFormElicitation({
      sessionId: 'session-1',
      mode: 'form',
      message: 'Provide release details.',
      requestedSchema: {
        type: 'object',
        properties: {
          releaseName: { type: 'string', title: 'Release name' }
        }
      }
    }, 'ACP Agent');

    expect(mapped).toEqual({
      type: 'MCP_ELICITATION',
      request: {
        mode: 'form',
        serverName: 'ACP Agent',
        message: 'Provide release details.',
        requestedSchema: {
          type: 'object',
          properties: {
            releaseName: { type: 'string', title: 'Release name' }
          }
        }
      }
    });
  });
});
