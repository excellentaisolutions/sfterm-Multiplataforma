// Job Object por terminal: si el daemon cae o se pide Kill, Windows termina
// el shell y todos los descendientes que este cree después de ser asignado.

use std::ffi::c_void;
use std::io;
use std::ptr::null;

type Handle = *mut c_void;
const PROCESS_TERMINATE: u32 = 0x0001;
const PROCESS_SET_QUOTA: u32 = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

#[repr(C)]
#[derive(Default)]
struct BasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimitInformation {
    basic_limit_information: BasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(
        job: Handle,
        info_class: i32,
        info: *const c_void,
        length: u32,
    ) -> i32;
    fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> Handle;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
}

pub struct Job(Handle);

unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn assign(process_id: u32) -> io::Result<Self> {
        let job = unsafe { CreateJobObjectW(null(), null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            let mut limits = ExtendedLimitInformation::default();
            limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    (&limits as *const ExtendedLimitInformation).cast(),
                    std::mem::size_of::<ExtendedLimitInformation>() as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }

            let process = unsafe {
                OpenProcess(
                    PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    process_id,
                )
            };
            if process.is_null() {
                return Err(io::Error::last_os_error());
            }
            let assigned = unsafe { AssignProcessToJobObject(job, process) };
            unsafe { CloseHandle(process) };
            if assigned == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        })();
        if let Err(error) = result {
            unsafe { CloseHandle(job) };
            return Err(error);
        }
        Ok(Self(job))
    }

    pub fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}
