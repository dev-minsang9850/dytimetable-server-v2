import {
    createDecipheriv,
    createHash,
    createHmac,
    timingSafeEqual,
} from 'node:crypto';
import { RawDataModel } from '../models/data';

const COMCI_ORIGIN = 'http://comci.net:4082';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface ComciProtocol {
    endpoint: string;
    prefix: string;
    key: Buffer;
    fields: Record<
        'teachers' | 'subjects' | 'original' | 'current' | 'teacher' | 'rooms' | 'updated',
        string
    >;
}

// Decode string data only. Never execute JavaScript received over HTTP.
export function readComciProtocol(html: string): ComciProtocol {
    let source = '';
    const blocks = html.matchAll(/\}\)\((\[\[[\s\S]*?\]\]),\s*(\d+)\s*\);/g);
    for (const block of blocks) {
        const chunks: unknown = JSON.parse(block[1]);
        const key = Number(block[2]);
        if (!Array.isArray(chunks)) throw new Error('Invalid Comci page encoding');
        for (const chunk of chunks) {
            if (!Array.isArray(chunk) || chunk.length !== 2 || typeof chunk[1] !== 'string') {
                throw new Error('Invalid Comci page encoding');
            }
            if (chunk[0] === 1) {
                source += chunk[1];
            } else if (chunk[0] === 0 && /^(?:[0-9a-f]{4})*$/i.test(chunk[1])) {
                for (let j = 0; j < chunk[1].length; j += 4) {
                    source += String.fromCharCode(
                        parseInt(chunk[1].slice(j, j + 4), 16) ^ ((key + (j / 4) * 13) & 255),
                    );
                }
            } else {
                throw new Error('Invalid Comci page encoding');
            }
        }
    }

    const extract = (pattern: RegExp): string => {
        const match = source.match(pattern);
        if (!match) throw new Error('Unsupported Comci page format');
        return match[1];
    };
    return {
        endpoint: extract(/var\s+sc3\s*=\s*['"]\.\/(\d+_T)\?['"]\s*\+\s*btoa\(/),
        prefix: extract(/sc_data\(\s*['"](\d+_)['"]/),
        key: Buffer.from(extract(/key\s*=\s*CryptoJS\.enc\.Hex\.parse\(['"]([0-9a-f]{64})['"]\)/i), 'hex'),
        fields: {
            teachers: extract(/성명\s*=\s*Q성명\(자료\.(자료\d+)\[/),
            subjects: extract(/과목명\s*=\s*Q과목명\(자료\.(자료\d+)\[/),
            original: extract(/원자료\s*=\s*Q자료\(자료\.(자료\d+)\[학년\]/),
            current: extract(/일일자료\s*=\s*Q자료\(자료\.(자료\d+)\[학년\]/),
            teacher: extract(/교사자료\s*=\s*Q자료\(자료\.(자료\d+)\[/),
            rooms: extract(/var\s+m3\s*=\s*자료\.(자료\d+)\[학년\]\[반\]\[요일\]\[교시\]/),
            updated: extract(/H시간표\.(자료\d+)\s*\|\|\s*['"]0['"]/),
        },
    };
}

export function decryptComciData(text: string, key: Buffer): Record<string, unknown> {
    const parts = text.replace(/\x00+$/, '').split(':');
    if (parts.length !== 4 || !['enc1', 'enc2'].includes(parts[0])) {
        throw new Error('Invalid Comci encrypted response');
    }
    const encoding = parts[0] === 'enc2' ? 'base64' : 'hex';
    const binary = parts.slice(1).map((part) => {
        const bytes = Buffer.from(part, encoding);
        if (!part || bytes.toString(encoding) !== part) {
            throw new Error('Invalid Comci response encoding');
        }
        return bytes;
    });
    const [iv, ciphertext, signature] = binary;
    if (iv.length !== 16 || signature.length !== 32 || !ciphertext.length || ciphertext.length % 16) {
        throw new Error('Invalid Comci encrypted response size');
    }
    const expected = createHmac('sha256', createHash('sha256').update(key).digest())
        .update(parts.slice(0, 3).join(':'))
        .digest();
    if (!timingSafeEqual(expected, signature)) {
        throw new Error('Comci response authentication failed');
    }
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
        .toString('utf8')
        .replace(/\x00+$/, '');
    const data: unknown = JSON.parse(plaintext);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Invalid Comci timetable object');
    }
    return data as Record<string, unknown>;
}

export function normalizeComciData(
    data: Record<string, unknown>,
    protocol: ComciProtocol,
): RawDataModel {
    const fields = protocol.fields;
    for (const field of ['teachers', 'subjects', 'original', 'current', 'teacher'] as const) {
        if (!Array.isArray(data[fields[field]])) {
            throw new Error('Missing Comci timetable field');
        }
    }
    if (
        !Number.isInteger(data.교사수) || (data.교사수 as number) < 1 ||
        !Array.isArray(data.학급수) || data.학급수.length < 4 ||
        !data.학급수.slice(1, 4).every((count) => Number.isInteger(count) && count >= 0 && count <= 100) ||
        !Array.isArray(data.일과시간) || !data.일과시간.length ||
        !data.일과시간.every((time) => typeof time === 'string') ||
        !Number.isInteger(data.분리) || (data.분리 as number) <= 0
    ) {
        throw new Error('Invalid Comci timetable metadata');
    }
    // Keep the existing internal model independent of the provider's rotating names.
    return {
        ...data,
        자료446: data[fields.teachers],
        자료492: data[fields.subjects],
        자료481: data[fields.original],
        자료147: data[fields.current],
        자료542: data[fields.teacher],
        자료245: data[fields.rooms],
        자료244: data[fields.updated],
    } as unknown as RawDataModel;
}

export async function fetchComciData(
    schoolCode: string | undefined,
    fetcher: typeof fetch = fetch,
): Promise<RawDataModel> {
    if (!schoolCode || !/^\d{4,10}$/.test(schoolCode)) {
        throw new Error('SCHOOL_CODE must be configured as a numeric school code');
    }
    const read = async (path: string, encoding: string): Promise<string> => {
        const response = await fetcher(`${COMCI_ORIGIN}/${path}`, {
            signal: AbortSignal.timeout(10_000),
            redirect: 'error',
        });
        if (!response.ok) throw new Error('Comci returned an unsuccessful HTTP status');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty Comci response');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_RESPONSE_BYTES) throw new Error('Comci response exceeded size limit');
                chunks.push(value);
            }
        } finally {
            await reader.cancel();
        }
        return new TextDecoder(encoding).decode(Buffer.concat(chunks));
    };
    // Reload the page for every renewal, and once more if an hourly rotation races it.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const protocol = readComciProtocol(await read('th', 'euc-kr'));
            const query = Buffer.from(`${protocol.prefix}${schoolCode}_0_1_enc2`).toString('base64');
            const text = await read(`${protocol.endpoint}?${query}`, 'utf-8');
            return normalizeComciData(decryptComciData(text, protocol.key), protocol);
        } catch {
            // Do not include URLs, response bodies, school codes or remote exceptions in logs.
            if (attempt === 1) throw new Error('Unable to retrieve valid Comci timetable data');
        }
    }
    throw new Error('Unable to retrieve valid Comci timetable data');
}
