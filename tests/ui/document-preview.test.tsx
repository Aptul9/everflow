// @vitest-environment jsdom
import { strToU8, zipSync } from 'fflate';
import { expect, test } from 'vitest';
import { officeFrame, readDocument } from '../../src/components/tickets/document-preview.tsx';

test('Office frame strips active markup and prevents resource loading', () => {
  const html = officeFrame('<p onclick="no()">Report</p><script>no()</script><img src="https://example.invalid/a.png"><a href="https://example.invalid/">Link</a><img src="data:image/png;base64,AA==">');
  expect(html).toContain("default-src 'none'");
  expect(html).toContain('Report');
  expect(html).toContain('data:image/png;base64,AA==');
  expect(html).not.toMatch(/<script|onclick|example\.invalid/);
});

test('an OpenDocument preview extracts text without interpreting markup', async () => {
  const bytes = zipSync({ 'content.xml': strToU8('<office:body xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><text:p>Approved &lt;b&gt;content&lt;/b&gt;</text:p></office:body>') });
  const preview = await readDocument('odt', Uint8Array.from(bytes).buffer);
  expect(preview).toMatchObject({ frame: expect.stringContaining('Approved &lt;b&gt;content&lt;/b&gt;') });
});

test('a Word preview renders a real document package into an isolated page', async () => {
  const bytes = zipSync({
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Audit trail</w:t></w:r></w:p></w:body></w:document>'),
  });
  const preview = await readDocument('docx', Uint8Array.from(bytes).buffer);
  expect(preview).toMatchObject({ frame: expect.stringContaining('Audit trail') });
});
