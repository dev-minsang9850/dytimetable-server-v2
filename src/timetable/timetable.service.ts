import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ParserService } from '../parser/parser.service';
import { isHoliday } from '@hyunbinseo/holidays-kr';
import { ClassPeriod } from '../models/timetable';
import { FirebaseService } from '../firebase/firebase.service';

@Injectable()
export class TimetableService implements OnModuleDestroy {
    constructor(
        private readonly parserService: ParserService,
        private readonly firebase: FirebaseService,
    ) {
        void this.#initializeAndSchedule();
    }

    #schedule: NodeJS.Timeout[] = [];
    #retryTimer: NodeJS.Timeout | null = null;
    #ready = false;
    #destroyed = false;
    #scheduling: Promise<void> | null = null;

    async #initializeAndSchedule() {
        if (this.#destroyed) return;
        if (!this.#ready) {
            try {
                await this.parserService.init();
                this.#ready = true;
            } catch {
                console.error('Timetable initialization failed; retrying in 30 seconds');
                this.#scheduleRecovery();
                return;
            }
        }
        if (this.#destroyed) return;
        const now = new Date();
        if (8 <= now.getHours() && now.getHours() <= 16) {
            try {
                await this._scheduleTimetable();
            } catch {
                console.error('Timetable scheduling failed; retrying in 30 seconds');
                this.#scheduleRecovery();
            }
        }
    }

    #scheduleRecovery() {
        if (this.#destroyed || this.#retryTimer) return;
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = null;
            void this.#initializeAndSchedule();
        }, 30_000);
    }

    async onModuleDestroy() {
        this.#destroyed = true;
        if (this.#retryTimer) clearTimeout(this.#retryTimer);
        this.#retryTimer = null;
        await this.clearSchedule();
    }
    #alertDisableDay = [
        '2024-9-4', // 9월 모의고사
    ];
    #alertDisableSpan = [
        '2024-7-22~2024-8-15', // 2024 여름 방학
    ];

    async clearSchedule() {
        for (const fId of this.#schedule) {
            clearTimeout(fId);
        }
        this.#schedule = [];
        console.log('cleared');
    }

    // Monday to Friday at 8 AM
    @Cron(CronExpression.MONDAY_TO_FRIDAY_AT_8AM)
    async _scheduleTimetable() {
        if (!this.#ready || this.#destroyed) return;
        if (this.#scheduling) return this.#scheduling;
        this.#scheduling = this.#createTimetableSchedule().finally(() => {
            this.#scheduling = null;
        });
        return this.#scheduling;
    }

    async #createTimetableSchedule() {
        await this.clearSchedule();

        const now = new Date();
        if (isHoliday(now)) return;
        if (this.isAlertDisableDay(now)) return;

        const todayBreakTimes = await this.parserService.getTodayBreakTimes();
        if (this.#destroyed) return;

        for (const breakTime of todayBreakTimes) {
            const delay = breakTime.getTime() - now.getTime();
            if (delay > 0) {
                const fId = setTimeout(() => {
                    void this.parserService.renewData(true)
                        .then(() => {
                            if (this.#destroyed) return;
                            return this._sendTimeTable(
                                todayBreakTimes.indexOf(breakTime) + 1,
                            );
                        })
                        .catch(() => {
                            console.error('Timetable notification refresh failed');
                        });
                }, delay);
                console.log(
                    'scheduled:',
                    breakTime,
                    `${todayBreakTimes.indexOf(breakTime) + 1}교시`,
                );
                this.#schedule.push(fId);
            }
        }
    }

    isAlertDisableDay(date: Date) {
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const day = date.getDate();

        const dayString = `${year}-${month}-${day}`;

        if (this.#alertDisableDay.includes(dayString)) return true;

        for (const span of this.#alertDisableSpan) {
            const [start, end] = span.split('~');
            const startDate = new Date(start);
            const endDate = new Date(end);

            if (date >= startDate && date <= endDate) return true;
        }

        return false;
    }

    // Monday to Friday at 7 AM
    @Cron(CronExpression.MONDAY_TO_FRIDAY_AT_7AM)
    async _sendTodaySportsAlert() {
        const studentTimetable = (await this.parserService.getTimetable())
            .student;
        const now = new Date();
        if (isHoliday(now)) return;
        if (this.isAlertDisableDay(now)) return;

        const weekday = now.getDay();

        Object.keys(studentTimetable).forEach((grade) => {
            Object.keys(studentTimetable[grade]).forEach((classroomNo) => {
                studentTimetable[grade][classroomNo][weekday].forEach(
                    (classPeriod: ClassPeriod | null) => {
                        if (!classPeriod) return;
                        if (
                            ['체육A', '체육B', '스포츠'].includes(
                                classPeriod.subject,
                            )
                        ) {
                            this.firebase.sendNotificationByTopic(
                                'period',
                                `${grade}-${classroomNo}`,
                                `체육복 알림`,
                                `오늘 ${classPeriod.classTime}교시에 체육이 있습니다. 체육복을 챙겨주세요.`,
                            );
                        }
                    },
                );
            });
        });
    }

    async _sendTimeTable(classTime: number) {
        const now = new Date();
        const weekday = now.getDay();
        const timetable = await this.parserService.getTimetable();

        // Student timetable
        Object.keys(timetable.student).forEach((grade) => {
            Object.keys(timetable.student[grade]).forEach((classroomNo) => {
                const classPeriod: ClassPeriod =
                    timetable.student[grade][classroomNo][weekday][
                        classTime - 1
                    ];
                if (classPeriod) {
                    this.firebase.sendNotificationByTopic(
                        'period',
                        `${classPeriod.grade}-${classPeriod.class}`,
                        classPeriod.isChanged
                            ? `다음 시간 알림 (수업 교환됨)`
                            : `다음 시간 알림`,
                        `${classPeriod.classTime}교시 [${classPeriod.subject}] 입니다.`,
                    );
                }
            });
        });

        // Teacher timetable
        Object.keys(timetable.teacher).forEach((teacherNo) => {
            const teacher = timetable.teacher[teacherNo];
            const classPeriod: ClassPeriod = teacher[weekday][classTime - 1];
            if (classPeriod) {
                this.firebase.sendNotificationByTopic(
                    'period',
                    `teacher-${teacherNo}`,
                    `다음 수업 알림`,
                    `${classPeriod.classTime}교시 [${classPeriod.grade}-${classPeriod.class} ${classPeriod.subject}] 입니다.`,
                );
            }
        });
    }

    async getTeachers() {
        return this.parserService.getTeachers();
    }

    async getTimetable(grade: string, classroom: string) {
        await this.parserService.renewData();
        const timetable = await this.parserService.getTimetable();
        if (grade === 'teacher') return timetable.teacher[classroom];
        else return timetable.student[grade][classroom];
    }

    async getAllTimetable() {
        return this.parserService.getTimetable();
    }
}
