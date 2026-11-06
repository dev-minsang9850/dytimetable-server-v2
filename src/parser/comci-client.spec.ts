import { createCipheriv, createHash, createHmac } from 'node:crypto';
import {
    ComciProtocol,
    decryptComciData,
    fetchComciData,
    normalizeComciData,
    readComciProtocol,
} from './comci-client';

// Fixtures are entirely synthetic: no provider responses or school data are stored.
function fixture(rotation = 1) {
    const key = Buffer.alloc(32, rotation);
    const fields = {
        teachers: `자료${rotation}01`,
        subjects: `자료${rotation}02`,
        original: `자료${rotation}03`,
        current: `자료${rotation}04`,
        teacher: `자료${rotation}05`,
        rooms: `자료${rotation}06`,
        updated: `자료${rotation}07`,
    };
    const protocol: ComciProtocol = {
        endpoint: `${rotation}00000_T`,
        prefix: `${rotation}0000_`,
        key,
        fields,
    };
    const source = `
        globalThis.__comciFixtureExecuted = true;
        var sc3='./${protocol.endpoint}?'+btoa(s7);
        sc_data('${protocol.prefix}',sc,1,'0');
        var key=CryptoJS.enc.Hex.parse('${key.toString('hex')}');
        성명=Q성명(자료.${fields.teachers}[th]);
        과목명=Q과목명(자료.${fields.subjects}[sb]);
        원자료=Q자료(자료.${fields.original}[학년][반][요일][교시]);
        일일자료=Q자료(자료.${fields.current}[학년][반][요일][교시]);
        교사자료=Q자료(자료.${fields.teacher}[교사][요일][교시]);
        var m3=자료.${fields.rooms}[학년][반][요일][교시];
        da1=H시간표.${fields.updated} || '0';
    `;
    const obfuscationKey = 73;
    const hex = Array.from(source, (character, index) =>
        (character.charCodeAt(0) ^ ((obfuscationKey + index * 13) & 255))
            .toString(16)
            .padStart(4, '0'),
    ).join('');
    const html = `<script>/* synthetic wrapper */(function(a,k){})([[0,"${hex}"]],${obfuscationKey});</script>`;
    const timetable = {
        학교명: 'Synthetic school',
        교사수: 1,
        학급수: [3, 1, 1, 1],
        일과시간: ['08:30'],
        분리: 1000,
        [fields.teachers]: ['', 'Teacher fixture'],
        [fields.subjects]: [0, 'Subject fixture'],
        [fields.original]: [0, [0, [0, [0, 1001]]]],
        [fields.current]: [0, [0, [0, [0, '>1001']]]],
        [fields.teacher]: [0, [0, [0, 1101]]],
        [fields.rooms]: [],
        [fields.updated]: 'Synthetic revision',
    };
    return { protocol, html, timetable };
}

function encrypt(data: unknown, key: Buffer, encoding: 'base64' | 'hex' = 'base64') {
    const iv = Buffer.alloc(16, 11);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(data) + '\x00', 'utf8'),
        cipher.final(),
    ]);
    const prefix = [
        encoding === 'base64' ? 'enc2' : 'enc1',
        iv.toString(encoding),
        ciphertext.toString(encoding),
    ].join(':');
    const signature = createHmac('sha256', createHash('sha256').update(key).digest())
        .update(prefix)
        .digest(encoding);
    return `${prefix}:${signature}\x00`;
}

describe('Comci protocol compatibility and response verification', () => {
    it('discovers rotated paths and field names without executing remote JavaScript', () => {
        delete (globalThis as Record<string, unknown>).__comciFixtureExecuted;
        for (const rotation of [1, 2]) {
            const { html, protocol } = fixture(rotation);
            expect(readComciProtocol(html)).toEqual(protocol);
        }
        expect((globalThis as Record<string, unknown>).__comciFixtureExecuted).toBeUndefined();
    });

    it('rejects an unsupported page rather than guessing an endpoint', () => {
        expect(() => readComciProtocol('<html>Unrecognized provider page</html>'))
            .toThrow('Unsupported Comci page format');
    });

    it.each(['base64', 'hex'] as const)('authenticates and decrypts %s responses', (encoding) => {
        const { timetable, protocol } = fixture();
        expect(decryptComciData(encrypt(timetable, protocol.key, encoding), protocol.key))
            .toEqual(timetable);
    });

    it('rejects a forged signature before accepting timetable data', () => {
        const { timetable, protocol } = fixture();
        const parts = encrypt(timetable, protocol.key).replace(/\x00+$/, '').split(':');
        parts[3] = Buffer.alloc(32).toString('base64');
        expect(() => decryptComciData(parts.join(':'), protocol.key))
            .toThrow('Comci response authentication failed');
    });

    it('rejects noncanonical encodings and unencrypted responses', () => {
        const { timetable, protocol } = fixture();
        const parts = encrypt(timetable, protocol.key).split(':');
        parts[1] += '\n';
        expect(() => decryptComciData(parts.join(':'), protocol.key))
            .toThrow('Invalid Comci response encoding');
        expect(() => decryptComciData('{}', protocol.key))
            .toThrow('Invalid Comci encrypted response');
    });

    it('maps rotated external fields to the existing internal model', () => {
        const { timetable, protocol } = fixture(2);
        const normalized = normalizeComciData(timetable, protocol);
        expect(normalized.자료446).toEqual(timetable[protocol.fields.teachers]);
        expect(normalized.자료492).toEqual(timetable[protocol.fields.subjects]);
        expect(normalized.자료481).toEqual(timetable[protocol.fields.original]);
        expect(normalized.자료147).toEqual(timetable[protocol.fields.current]);
        expect(normalized.자료542).toEqual(timetable[protocol.fields.teacher]);
        expect(normalized.자료245).toEqual(timetable[protocol.fields.rooms]);
        expect(normalized.자료244).toEqual('Synthetic revision');
    });

    it('rejects missing timetable arrays and invalid class counts', () => {
        const { timetable, protocol } = fixture();
        const missing = { ...timetable };
        delete missing[protocol.fields.current];
        expect(() => normalizeComciData(missing, protocol)).toThrow('Missing Comci timetable field');
        expect(() => normalizeComciData({ ...timetable, 학급수: [3, -1, 1, 1] }, protocol))
            .toThrow('Invalid Comci timetable metadata');
    });
});

describe('Comci requests', () => {
    it('reloads the protocol when a provider rotation races a request', async () => {
        const first = fixture(1);
        const second = fixture(2);
        const fetcher = jest.fn()
            .mockResolvedValueOnce(new Response(first.html))
            .mockResolvedValueOnce(new Response('{}'))
            .mockResolvedValueOnce(new Response(second.html))
            .mockResolvedValueOnce(new Response(encrypt(second.timetable, second.protocol.key)));
        const data = await fetchComciData('99999', fetcher as typeof fetch);
        expect(data.자료446).toEqual(second.timetable[second.protocol.fields.teachers]);
        expect(fetcher).toHaveBeenCalledTimes(4);
        expect(fetcher.mock.calls[0][0]).toBe('http://comci.net:4082/th');
        expect(fetcher.mock.calls[2][0]).toBe('http://comci.net:4082/th');
        const requested = new URL(fetcher.mock.calls[3][0]);
        expect(requested.pathname).toBe(`/${second.protocol.endpoint}`);
        expect(Buffer.from(requested.search.slice(1), 'base64').toString())
            .toBe(`${second.protocol.prefix}99999_0_1_enc2`);
        expect(fetcher.mock.calls[3][1]).toEqual(expect.objectContaining({
            redirect: 'error',
            signal: expect.any(AbortSignal),
        }));
    });

    it('rejects invalid school configuration before any network request', async () => {
        const fetcher = jest.fn();
        await expect(fetchComciData('../private', fetcher as typeof fetch))
            .rejects.toThrow('SCHOOL_CODE must be configured as a numeric school code');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('sanitizes provider errors so school codes and response bodies cannot escape', async () => {
        const fetcher = jest.fn().mockRejectedValue(new Error('99999 private-response-body'));
        await expect(fetchComciData('99999', fetcher as typeof fetch))
            .rejects.toEqual(new Error('Unable to retrieve valid Comci timetable data'));
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});
