import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The openrows login theme overrides one keycloak.v2 template, register.ftl, to show the
// identity-provider buttons on the registration page. It is a copy of the parent's file, so a
// Keycloak image upgrade must re-sync it: the version in its header has to match the image.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const register = read('./themes/openrows/login/register.ftl');

describe('docker/keycloak/themes/openrows/login/register.ftl', () => {
  it("shows the identity providers with the parent's social-providers.ftl", () => {
    expect(register).toContain('<#import "social-providers.ftl" as identityProviders>');
    expect(register).toMatch(
      /<#elseif section = "socialProviders" >\s*<#if realm\.password && social\.providers\?\? && social\.providers\?has_content>\s*<@identityProviders\.show social=social\/>/
    );
  });

  it("keeps keycloak.v2's registration form", () => {
    expect(register).toContain(
      `<form id="kc-register-form" class="\${properties.kcFormClass!}" action="\${url.registrationAction}" method="post"`
    );
  });

  it('names the Keycloak version the Compose files pin', () => {
    const version = /register\.ftl from Keycloak (\d+\.\d+\.\d+)/.exec(register)?.[1];
    expect(version).toBeDefined();
    for (const file of ['../dev.yml', '../selfhost.yml']) {
      expect(read(file)).toContain(`image: quay.io/keycloak/keycloak:${version}@`);
    }
  });
});
