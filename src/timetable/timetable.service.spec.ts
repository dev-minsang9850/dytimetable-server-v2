import { TimetableService } from './timetable.service';
import { ParserService } from '../parser/parser.service';
import { FirebaseService } from '../firebase/firebase.service';

jest.mock('../parser/parser.service', () => ({ ParserService: class {} }));
jest.mock('../firebase/firebase.service', () => ({ FirebaseService: class {} }));
jest.mock('@hyunbinseo/holidays-kr', () => ({ isHoliday: () => false }));

describe('TimetableService recovery', () => {
    let parser: {
        init: jest.Mock;
        getTodayBreakTimes: jest.Mock;
        renewData: jest.Mock;
        getTimetable: jest.Mock;
    };
    let service: TimetableService;

    const settle = async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
    };
    const create = () => {
        service = new TimetableService(
            parser as unknown as ParserService,
            {} as FirebaseService,
        );
        return service;
    };

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(2026, 10, 6, 10, 0));
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        parser = {
            init: jest.fn().mockResolvedValue(undefined),
            getTodayBreakTimes: jest.fn().mockResolvedValue([]),
            renewData: jest.fn().mockResolvedValue(undefined),
            getTimetable: jest.fn().mockResolvedValue({ student: {}, teacher: {} }),
        };
    });

    afterEach(async () => {
        if (service) await service.onModuleDestroy();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('retries initialization after 30 seconds and schedules only after success', async () => {
        parser.init.mockRejectedValueOnce(new Error('sensitive upstream detail'));
        create();
        await settle();
        expect(parser.getTodayBreakTimes).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith(
            'Timetable initialization failed; retrying in 30 seconds',
        );
        await jest.advanceTimersByTimeAsync(29_999);
        expect(parser.init).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(parser.init).toHaveBeenCalledTimes(2);
        expect(parser.getTodayBreakTimes).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('retries scheduling without initializing an already initialized parser', async () => {
        parser.getTodayBreakTimes.mockRejectedValueOnce(new Error('unavailable'));
        create();
        await settle();
        await jest.advanceTimersByTimeAsync(30_000);
        expect(parser.init).toHaveBeenCalledTimes(1);
        expect(parser.getTodayBreakTimes).toHaveBeenCalledTimes(2);
    });

    it('cancels initialization recovery when the module is destroyed', async () => {
        parser.init.mockRejectedValue(new Error('unavailable'));
        create();
        await settle();
        await service.onModuleDestroy();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(parser.init).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('coalesces simultaneous scheduling and does not create timers after destruction', async () => {
        let resolve: (times: Date[]) => void;
        parser.getTodayBreakTimes.mockReturnValue(new Promise<Date[]>((done) => {
            resolve = done;
        }));
        create();
        await settle();
        const second = service._scheduleTimetable();
        await service.onModuleDestroy();
        resolve([new Date(Date.now() + 1_000)]);
        await second;
        expect(parser.getTodayBreakTimes).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('handles a failed refresh from a notification timer', async () => {
        parser.getTodayBreakTimes.mockResolvedValue([new Date(Date.now() + 1_000)]);
        parser.renewData.mockRejectedValue(new Error('sensitive upstream detail'));
        create();
        await settle();
        await jest.advanceTimersByTimeAsync(1_000);
        expect(parser.getTimetable).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith('Timetable notification refresh failed');
    });

    it('handles a failure while preparing notifications after refresh', async () => {
        parser.getTodayBreakTimes.mockResolvedValue([new Date(Date.now() + 1_000)]);
        parser.getTimetable.mockRejectedValue(new Error('unavailable'));
        create();
        await settle();
        await jest.advanceTimersByTimeAsync(1_000);
        expect(console.error).toHaveBeenCalledWith('Timetable notification refresh failed');
    });
});
