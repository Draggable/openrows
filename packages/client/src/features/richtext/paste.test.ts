import { describe, expect, it, vi } from 'vitest';
import { sanitizePastedHtml } from './paste';

describe('sanitizePastedHtml', () => {
  it('drops scripts, handlers, embeds and unsafe links', () => {
    const html = sanitizePastedHtml(
      '<meta charset="utf-8"><p onclick="alert(1)" class="x"><b>Bold</b> <img src=x onerror="alert(1)">' +
        '<script>alert(1)</script><a href="javascript:alert(1)">bad</a> ' +
        '<a href=" https://openrows.io " onmouseover="alert(1)" target="_top">good</a></p>' +
        '<iframe src="https://evil.example"></iframe><svg onload="alert(1)"><a href="x">s</a></svg>' +
        '<style>*{}</style><form action="https://evil.example"><input value="x"></form>' +
        '<font color="red">plain</font>'
    );
    expect(html).toBe('<p><b>Bold</b> <a>bad</a> <a href="https://openrows.io">good</a></p>plain');
  });

  it('renames handler attributes before the HTML is parsed', () => {
    const spy = vi.spyOn(DOMParser.prototype, 'parseFromString');
    sanitizePastedHtml('<img src="x"onerror=alert(1)><svg/onload=alert(1)><p ONCLICK = "a">x</p>');
    expect(spy.mock.calls[0]?.[0]).not.toMatch(/[\s/"']on[a-z]+\s*=/i);
    spy.mockRestore();
  });

  it('keeps task lists and the styles that mean bold, italic or strikethrough', () => {
    expect(
      sanitizePastedHtml(
        '<ul data-type="taskList" data-foo="1"><li data-type="taskItem" data-checked="true">a</li></ul>' +
          '<span style="font-weight: 700; color: red; background: url(javascript:alert(1))">b</span>' +
          '<span style="font-style: url(x)">c</span>'
      )
    ).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true">a</li></ul>' +
        '<span style="font-weight: 700">b</span><span>c</span>'
    );
  });
});
