import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

/**
 * A personal access token and the server it belongs to. n8n adds the bearer header to
 * every request the nodes send through `httpRequestWithAuthentication`; the token never appears
 * in a node's output or errors.
 */
export class OpenRowsApi implements ICredentialType {
  name = 'openRowsApi';

  displayName = 'OpenRows API';

  documentationUrl = 'https://app.openrows.io/docs/api';

  icon = 'file:openrows.svg' as const;

  properties: INodeProperties[] = [
    {
      displayName: 'Server URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://app.openrows.io',
      required: true,
      placeholder: 'https://app.openrows.io',
      description:
        'Your OpenRows server: https://app.openrows.io, or your own for a self-hosted one',
    },
    {
      displayName: 'Personal Access Token',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      placeholder: 'or_pat_…',
      description:
        'Create one in OpenRows under Settings → Developer: personal access tokens. The nodes need schema.bases:read, data.records:read and data.records:write; the trigger also needs webhook:manage.',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: { Authorization: '=Bearer {{$credentials.apiKey}}' },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
      url: '/api/v1/meta/bases',
    },
  };
}
