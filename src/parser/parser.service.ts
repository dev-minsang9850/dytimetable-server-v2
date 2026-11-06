import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { fetchComciData } from './comci-client';
import {
    ClassPeriod,
    ClassroomNoT,
    GradeT,
    StudentTimeTableModel,
    TeacherTimeTableModel,
    TimeTableModel,
    WeekdayStringT,
    WeekdayT,
    weekdayTimeTable,
} from 'src/models/timetable';
import { DataModel, RawDataModel } from 'src/models/data';

@Injectable()
export class ParserService {
    constructor() {}

    #init: boolean = false;
    #data: DataModel | null = null;
    #timetable: TimeTableModel;
    #weekdayString: string[] = ['일', '월', '화', '수', '목', '금', '토'];
    #renewTime: Date | null = null;
    #renewing: Promise<void> | null = null;

    async init() {
        if (this.#init) throw new Error('ParserService is already initialized');
        try {
            await this.renewData(true);
            this.#init = true;
        } catch (e) {
            console.error('Unable to initialize timetable data');
            throw new Error('Failed to initialize ParserService');
        }
    }

    async renewData(force = false) {
        if (this.#renewing) return this.#renewing;
        const now = new Date();
        if (
            this.#renewTime != null &&
            this.#data != null &&
            now.getTime() - this.#renewTime.getTime() < 1000 * 60 * 10 &&
            !force
        )
            return;
        this.#renewing = this._getData()
            .then((data) => {
                this.#timetable = data;
                this.#renewTime = new Date();
                console.log(new Date(), 'Data renewed');
            })
            .finally(() => {
                this.#renewing = null;
            });
        return this.#renewing;
    }

    async getTimetable() {
        if (!this.#init) throw new ServiceUnavailableException('Timetable data is not ready');
        await this.renewData();
        return this.#timetable;
    }

    async getTeachers() {
        if (!this.#init) throw new ServiceUnavailableException('Timetable data is not ready');
        await this.renewData();
        return this.#data.teachers;
    }

    async getTodayBreakTimes(): Promise<Date[]> {
        if (!this.#init) throw new ServiceUnavailableException('Timetable data is not ready');
        await this.renewData();
        const rawClassTimes = this.#data.classTimes;
        const result = [];
        for (let i = 0; i < rawClassTimes.length; i++) {
            const times = rawClassTimes[i].match(/\d{2}/g);
            const classTime = new Date();
            classTime.setHours(Number(times[0]));
            classTime.setMinutes(Number(times[1]));
            classTime.setSeconds(0);
            classTime.setMilliseconds(0);
            const breaks = classTime.getTime() - 10 * 60000;

            result.push(new Date(breaks));
        }

        return result;
    }

    async _getData() {
        const rawData = await this._getRawData();
        const previous = this.#data;
        this.#data = await this._parseRawData(rawData);
        try {
            return {
                ...(await this._makeStudentTimeTable()),
                ...(await this._makeTeacherTimeTable()),
            } satisfies TimeTableModel;
        } catch (error) {
            this.#data = previous;
            throw error;
        }
    }

    async _getRawData() {
        try {
            return await fetchComciData(process.env.SCHOOL_CODE);
        } catch {
            throw new ServiceUnavailableException('Timetable data is temporarily unavailable');
        }
    }

    async _parseRawData(rawData: RawDataModel) {
        const parsedData: DataModel = {
            schoolName: rawData.학교명,
            regionName: rawData.지역명,
            schoolYear: rawData.학년도,
            semesterStartDate: rawData.학기시작일자,
            timetableStartDate: rawData.시작일,
            timetableEndDate: rawData.열람제한일,
            teacherCount: rawData.교사수,
            classCount: rawData.학급수,
            virtualClassCount: rawData.가상학급수,
            specialRoomCount: rawData.특별실수,
            simultaneousClassCount: rawData.동시수업수,
            simultaneousGroup: rawData.동시그룹,
            yesterday: rawData.전일제,
            version: rawData.버젼,
            restrictedDate: rawData.열람제한일,
            separator: rawData.분리,
            isLectureRoom: rawData.강의실,
            isTodayR: rawData.오늘r,
            homeroomTeacher: rawData.담임,
            classTimes: rawData.일과시간,
            dayData: rawData.일자자료,
            serverTime: rawData.자료244,
            classroom: rawData.자료245,
            teachers: rawData.자료446,
            originalTimeTable: rawData.자료481,
            subjects: rawData.자료492,
            nowTimeTable: rawData.자료147,
            teacherTimeTable: rawData.자료542,
            weekdayTime: rawData.요일별시수,
        };

        return parsedData;
    }

    _calcTeacherViaSTT(data: number, separator: number) {
        let teacherNo: number = -1;
        if (separator == 100) {
            teacherNo = Math.floor(data / separator);
        } else {
            teacherNo = data % separator;
        }

        return teacherNo;
    }

    _calcSubjectViaSTT(data: number, separator: number) {
        let subjectIndex: number = -1;
        if (separator == 100) {
            subjectIndex = data % separator;
        } else {
            subjectIndex = Math.floor(data / separator);
        }

        return subjectIndex % separator;
    }

    async _makeStudentTimeTable(): Promise<StudentTimeTableModel> {
        const result: StudentTimeTableModel = {
            student: {
                1: undefined,
                2: undefined,
                3: undefined,
            },
        };

        for (let grade = 1; grade <= 3; grade++) {
            result.student[grade] = {};
            for (let classroomNo = 1; classroomNo <= this.#data.classCount[grade]; classroomNo++) {
                if (result.student[grade][classroomNo] == null)
                    result.student[grade][classroomNo] = [];
                result.student[grade][classroomNo] =
                    await this._getStudentTimeTableByClassroom(
                        grade as GradeT,
                        classroomNo as ClassroomNoT,
                    );
            }
        }

        return result;
    }

    async _makeTeacherTimeTable(): Promise<TeacherTimeTableModel> {
        const result: TeacherTimeTableModel = {
            teacher: {},
        };

        for (
            let teacherNo = 1;
            teacherNo <= this.#data.teacherCount;
            teacherNo++
        ) {
            result.teacher[teacherNo] = {
                name: this.#data.teachers[teacherNo],
                ...(await this._getTeacherTimeTableByTeacherNo(teacherNo)),
            };
        }

        return result;
    }

    async _getStudentTimeTableByClassroom(
        grade: GradeT,
        classroomNo: ClassroomNoT,
    ) {
        const separator = this.#data.separator;
        const results = {} as weekdayTimeTable;

        for (let weekday = 1; weekday <= 5; weekday++) {
            results[weekday] = [];
            const todayData = this.#data.nowTimeTable[grade]?.[classroomNo]?.[
                weekday
            ] as Array<number>;
            const originalData = this.#data.originalTimeTable[grade]?.[
                classroomNo
            ]?.[weekday] as Array<number>;
            const loopLength = (todayData && todayData.length > 1) ? todayData.length : (originalData ? originalData.length : 0);

            for (let period = 1; period < loopLength; period++) {
                results[weekday].push(null);

                let periodDataRaw = todayData ? todayData[period] : null;

                if (periodDataRaw == null && originalData) {
                    periodDataRaw = originalData[period];
                }
                if (!periodDataRaw) continue;

                const periodDataList = Array.isArray(periodDataRaw) ? periodDataRaw : [periodDataRaw];
                let firstData = periodDataList[0];

                if (typeof firstData === 'string') {
                    firstData = parseInt(firstData.replace(/[^0-9]/g, ''), 10);
                }

                if (firstData > 100) {
                    const isChanged = !!(todayData && todayData[period]) &&
                        JSON.stringify(todayData[period]) !== JSON.stringify(originalData ? originalData[period] : null);

                    const teacher = this._calcTeacherViaSTT(firstData, separator);
                    const subject = this._calcSubjectViaSTT(firstData, separator);

                    const result: ClassPeriod = {
                        grade: grade,
                        class: classroomNo,
                        weekday: weekday as WeekdayT,
                        weekdayString: this.#weekdayString[weekday] as WeekdayStringT,
                        classTime: period,
                        subject: this.#data.subjects[subject] as string,
                        teacher: this.#data.teachers[teacher],
                        isChanged: isChanged,
                    };

                    results[weekday][period - 1] = result;
                }
            }
        }

        return results;
    }

    async _getTeacherTimeTableByTeacherNo(
        teacherNo: number,
    ): Promise<weekdayTimeTable> {
        const teacher = this.#data.teachers[teacherNo];
        const teacherTimeTable = this.#data.teacherTimeTable[teacherNo];
        const separator = this.#data.separator;

        const results = {} as weekdayTimeTable;

        for (let weekday = 1; weekday <= 5; weekday++) {
            results[weekday] = [];
            if (!teacherTimeTable || !teacherTimeTable[weekday]) {
                for (let period = 1; period <= 7; period++) results[weekday].push(null);
                continue;
            }

            const weekdayData = teacherTimeTable[weekday] as Array<any>;
            const maxPeriod = weekdayData.length > 1 ? weekdayData.length : 8;

            for (let period = 1; period < maxPeriod; period++) {
                results[weekday].push(null);

                let dataRaw = weekdayData[period];
                if (!dataRaw) continue;

                const dataList = Array.isArray(dataRaw) ? dataRaw : [dataRaw];
                let data = dataList[0];

                if (typeof data === 'string') {
                    data = parseInt(data.replace(/[^0-9]/g, ''), 10);
                }

                if (data > 100) {
                    const classroom = data % separator;
                    const grade = Math.floor(classroom / 100) as GradeT;
                    const classroomNo = classroom % 100;
                    const subject = Math.floor(data / separator) % separator;
                    const result: ClassPeriod = {
                        teacher: teacher,
                        weekday: weekday as WeekdayT,
                        weekdayString: this.#weekdayString[weekday] as WeekdayStringT,
                        grade,
                        class: classroomNo as ClassroomNoT,
                        subject: this.#data.subjects[subject] as string,
                        classTime: period,
                    };

                    results[weekday][period - 1] = result;
                }
            }
        }

        return results;
    }
}
