use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;

use anyhow::{Context, Result, bail};
#[cfg(not(windows))]
use fs2::FileExt;

#[derive(Debug)]
pub(crate) struct Lease(File);

impl Lease {
    pub(crate) fn inheritable(&self) -> io::Result<File> {
        fs2::FileExt::duplicate(&self.0)
    }
}

#[cfg(not(windows))]
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

pub(super) fn acquire(path: &Path) -> Result<Lease> {
    if !path.try_exists()? {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(path) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error).context("failed to create Kimi catalog lease"),
        };
    }
    let lease = open_lease(path, false)?;
    #[cfg(not(windows))]
    FileExt::try_lock_shared(&lease).context("failed to share Kimi catalog lease")?;
    Ok(Lease(lease))
}

fn open_lease(path: &Path, write: bool) -> Result<File> {
    if !fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect Kimi lease {}", path.display()))?
        .file_type()
        .is_file()
    {
        bail!("Kimi lease {} is not a regular file", path.display());
    }
    let mut options = OpenOptions::new();
    options.read(true).write(write);
    #[cfg(windows)]
    if !write {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        options.share_mode(FILE_SHARE_READ);
    }
    options.open(path).with_context(|| format!("failed to open Kimi lease {}", path.display()))
}

pub(super) fn is_active(path: &Path) -> Result<bool> {
    #[cfg(windows)]
    {
        const ERROR_SHARING_VIOLATION: i32 = 32;
        match open_lease(path, true) {
            Ok(_) => Ok(false),
            Err(error)
                if error.downcast_ref::<io::Error>().and_then(io::Error::raw_os_error)
                    == Some(ERROR_SHARING_VIOLATION) =>
            {
                Ok(true)
            }
            Err(error) => Err(error),
        }
    }
    #[cfg(not(windows))]
    {
        let file = open_lease(path, true)?;
        match file.try_lock_exclusive() {
            Ok(()) => {
                FileExt::unlock(&file).context("failed to release Kimi lease probe")?;
                Ok(false)
            }
            Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                Ok(true)
            }
            Err(error) => Err(error).context("failed to inspect Kimi lease lock"),
        }
    }
}
