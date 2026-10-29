<#-- The layout of every Keycloak email, like the app's (packages/server/src/email/templates.ts):
     warm paper, a white card with a rose top bar, the wordmark. No images, so nothing is blocked. -->
<#macro emailLayout>
<html lang="${locale.language}" dir="${(ltr)?then('ltr','rtl')}">
<body style="font-family: Inter, system-ui, sans-serif; color: #1C1719; background: #FAF7F5; margin: 0; padding: 24px 12px;">
  <div style="max-width: 560px; margin: 0 auto; background: #FFFFFF; border: 1px solid #E8E2DD; border-top: 3px solid #E22651; border-radius: 8px; padding: 24px;">
    <p style="margin: 0 0 20px; font-size: 17px; font-weight: 700; letter-spacing: -0.01em;">OpenRows</p>
    <#nested>
  </div>
  <p style="max-width: 560px; margin: 16px auto 0; color: #6E6468; font-size: 12px;">Sent by OpenRows.</p>
</body>
</html>
</#macro>
