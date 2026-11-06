import { ParserService } from './parser.service';
import { RawDataModel } from '../models/data';

jest.mock('./comci-client', () => ({ fetchComciData: jest.fn() }));

const rawData = (teacher = 'Teacher A'): RawDataModel => ({
    학교명: 'Synthetic school',
    지역명: 'Synthetic region',
    학년도: 2026,
    교사수: 1,
    학급수: [0, 1, 0, 0],
    가상학급수: [0, 0, 0, 0],
    분리: 1000,
    자료446: ['', teacher],
    자료492: [0, 'Subject A', 'Subject B'],
    자료481: [null, [null, { 1: [0, 1001] }]],
    자료147: [null, [null, { 1: [0, 1001] }]],
    자료542: [null, { 1: [0, 1101] }],
    일과시간: ['09:00'],
} as unknown as RawDataModel);

describe('ParserService recovery and conversion', () => {
    let parser: ParserService;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(2026, 10, 6, 10, 0));
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        parser = new ParserService();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('returns HTTP 503 before data is initialized without attempting network collection', async () => {
        const fetch = jest.spyOn(parser, '_getRawData');
        for (const result of [
            parser.getTimetable(),
            parser.getTeachers(),
            parser.getTodayBreakTimes(),
        ]) {
            await expect(result).rejects.toMatchObject({ status: 503 });
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it('coalesces simultaneous refreshes and caches the completed result', async () => {
        let resolve: (data: RawDataModel) => void;
        const fetch = jest.spyOn(parser, '_getRawData').mockReturnValue(
            new Promise<RawDataModel>((done) => { resolve = done; }),
        );
        const first = parser.renewData(true);
        const second = parser.renewData(true);
        const third = parser.renewData();
        expect(fetch).toHaveBeenCalledTimes(1);
        resolve(rawData());
        await Promise.all([first, second, third]);
        await parser.renewData();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('waits for a forced refresh before reading a still-fresh cache', async () => {
        const fetch = jest.spyOn(parser, '_getRawData').mockResolvedValue(rawData());
        await parser.init();
        const previous = await parser.getTimetable();
        fetch.mockResolvedValue(rawData('Teacher B'));

        let finishConversion: () => void;
        const gate = new Promise<void>((resolve) => { finishConversion = resolve; });
        const convert = parser._makeStudentTimeTable.bind(parser);
        jest.spyOn(parser, '_makeStudentTimeTable').mockImplementationOnce(async () => {
            await gate;
            return convert();
        });
        const refresh = parser.renewData(true);
        for (let i = 0; i < 6; i++) await Promise.resolve();

        const teachersReady = jest.fn();
        const timetableReady = jest.fn();
        const teachers = parser.getTeachers().then((data) => {
            teachersReady();
            return data;
        });
        const timetable = parser.getTimetable().then((data) => {
            timetableReady();
            return data;
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
        expect(teachersReady).not.toHaveBeenCalled();
        expect(timetableReady).not.toHaveBeenCalled();

        finishConversion();
        await refresh;
        expect(await teachers).toEqual(['', 'Teacher B']);
        const updated = await timetable;
        expect(updated).not.toBe(previous);
        expect(updated.student[1][1][1][0].teacher).toBe('Teacher B');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('allows initialization retry after a collection failure', async () => {
        const fetch = jest.spyOn(parser, '_getRawData')
            .mockRejectedValueOnce(new Error('sensitive upstream detail'))
            .mockResolvedValue(rawData());
        await expect(parser.init()).rejects.toThrow('Failed to initialize ParserService');
        expect(console.error).toHaveBeenCalledWith('Unable to initialize timetable data');
        await parser.init();
        expect(await parser.getTeachers()).toEqual(['', 'Teacher A']);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it.each(['parsing', 'conversion'])('keeps prior data and renewal time after %s fails', async (failure) => {
        const fetch = jest.spyOn(parser, '_getRawData').mockResolvedValue(rawData());
        await parser.init();
        const original = await parser.getTimetable();
        jest.advanceTimersByTime(5 * 60 * 1000);
        fetch.mockResolvedValue(rawData('Teacher B'));
        if (failure === 'parsing') {
            jest.spyOn(parser, '_parseRawData').mockRejectedValueOnce(new Error('parse failed'));
        } else {
            jest.spyOn(parser, '_makeTeacherTimeTable').mockRejectedValueOnce(new Error('conversion failed'));
        }
        await expect(parser.renewData(true)).rejects.toThrow('failed');
        expect(await parser.getTeachers()).toEqual(['', 'Teacher A']);
        expect(await parser.getTimetable()).toBe(original);
        expect(fetch).toHaveBeenCalledTimes(2);

        // Ten minutes from the successful refresh, not from the failed attempt.
        jest.advanceTimersByTime(5 * 60 * 1000);
        expect(await parser.getTeachers()).toEqual(['', 'Teacher B']);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('uses each grade class count and handles classrooms absent from both timetable arrays', async () => {
        const raw = rawData();
        raw.학급수 = [0, 11, 1, 0];
        jest.spyOn(parser, '_getRawData').mockResolvedValue(raw);
        await parser.init();
        const data = await parser.getTimetable();
        expect(Object.keys(data.student[1])).toHaveLength(11);
        expect(data.student[1][12]).toBeUndefined();
        expect(data.student[1][11]).toEqual({ 1: [], 2: [], 3: [], 4: [], 5: [] });
        expect(data.student[2][1]).toEqual({ 1: [], 2: [], 3: [], 4: [], 5: [] });
        expect(data.student[3]).toEqual({});
        expect(data.student[1][1][1][0]).toMatchObject({
            grade: 1, class: 1, subject: 'Subject A', teacher: 'Teacher A', isChanged: false,
        });
    });

    it('decodes changed-lesson strings and preserves explicit cancelled slots', async () => {
        const raw = rawData();
        raw.자료147 = [null, [null, { 1: [0, '>2001', 0] }]] as unknown as RawDataModel['자료147'];
        raw.자료481 = [null, [null, { 1: [0, 1001, 1001] }]] as unknown as RawDataModel['자료481'];
        jest.spyOn(parser, '_getRawData').mockResolvedValue(raw);
        await parser.init();
        const data = await parser.getTimetable();
        expect(data.student[1][1][1][0]).toMatchObject({ subject: 'Subject B', isChanged: true });
        expect(data.student[1][1][1][1]).toBeNull();
    });

    it('falls back to original data when a current slot is absent', async () => {
        const raw = rawData();
        raw.자료147 = [null, [null, { 1: [0, undefined] }]] as unknown as RawDataModel['자료147'];
        jest.spyOn(parser, '_getRawData').mockResolvedValue(raw);
        await parser.init();
        const data = await parser.getTimetable();
        expect(data.student[1][1][1][0]).toMatchObject({ subject: 'Subject A', isChanged: false });
    });
});
