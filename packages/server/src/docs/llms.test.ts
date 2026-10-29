import { describe, expect, it } from 'vitest';
import { testApp } from '../../test/helpers/app.js';

describe('/llms.txt (#116)', () => {
  it('points agents at the API docs, the SDK and the MCP server, on this server', async () => {
    const { app, config } = testApp();
    const res = await app.request('/llms.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const body = await res.text();
    expect(body).toMatch(/^# OpenRows\n\n> /);
    for (const path of [
      '/docs/api',
      '/api/openapi.json',
      '/docs/api/sdk',
      '/docs/api/mcp',
      '/docs/api#n8n',
      '/docs/api#webhooks',
      '/mcp',
    ]) {
      expect(body).toContain(`${config.appUrl}${path}`);
    }
    expect(body).toContain('npx -y @openrows/mcp-server');
  });

  it('links the user guide, the self-hosting guide and the public source code', async () => {
    const { app } = testApp();
    const body = await (await app.request('/llms.txt')).text();
    for (const url of [
      'https://openrows.io/docs)',
      'https://openrows.io/docs/self-hosting)',
      'https://openrows.io/docs/airtable-migration)',
      'https://github.com/Draggable/openrows)',
    ]) {
      expect(body).toContain(`(${url}`);
    }
    expect(body).toMatch(/AGPL-3\.0/);
    expect(body).not.toMatch(/\/ee\/|openrows-cloud/);
  });
});
