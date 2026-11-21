"""One active interactive desktop per account; phones and cloud nodes coexist."""
from sqlalchemy import select, update, func, or_

from ..models import Client
from ..automation_models import RunnerNode

DESKTOP_PLATFORMS = {"win32", "windows", "darwin", "macos", "linux"}


def base_platform(value) -> str:
    """Reduce a reported platform to its OS name.

    Desktop clients report ``<platform>/<arch>`` (for example ``linux/x64`` or
    ``darwin/arm64``), while other callers store the bare OS name. Both shapes
    reach this module, so compare on the OS name only: a client reporting an
    arch otherwise never matches the allow-list, its previous desktop is never
    signed out, and the one-desktop-per-account rule silently stops applying.
    """
    return str(value or "").split("/", 1)[0].strip().lower()


def _desktop_platform_sql():
    # No split() in SQLite, so match the bare OS name plus the "<name>/<arch>"
    # shape the client actually reports.
    lowered = func.lower(Client.platform)
    return or_(*(lowered == name for name in sorted(DESKTOP_PLATFORMS)),
               *(lowered.like(name + "/%") for name in sorted(DESKTOP_PLATFORMS)))


async def lock_devices(session, client, user):
    # Account switches can target devices currently owned by another account.
    # Lock the complete affected device set in one stable order before mutation.
    await session.scalars(select(Client.id).where(or_(Client.id == client.id,
        Client.user_ref == user.id)).order_by(Client.id).with_for_update())


async def lock_assignment(session, client, user):
    """Share the account/device lock order across login and admin assignment."""
    await session.refresh(user, with_for_update=True)
    await lock_devices(session, client, user)
    await session.refresh(client, with_for_update=True)


async def replace_previous(session, client, user):
    # complete_login holds the account row lock before calling this function.
    # Clearing user_ref would invalidate independent cloud recovery receipts;
    # revoke authentication while preserving historical account provenance.
    if base_platform(client.platform) not in DESKTOP_PLATFORMS:
        return []
    cloud_devices = select(RunnerNode.client_id).where(RunnerNode.owner_user_id.is_not(None), RunnerNode.client_id != "")
    if await session.scalar(select(RunnerNode.id).where(
            RunnerNode.client_id == client.id, RunnerNode.owner_user_id.is_not(None)).limit(1)):
        return []
    previous = list((await session.scalars(select(Client.id).where(
        Client.user_ref == user.id, Client.id != client.id, Client.auth_state == "active",
        _desktop_platform_sql(), Client.id.not_in(cloud_devices),
    ).order_by(Client.id).with_for_update())).all())
    if previous:
        await session.execute(update(Client).where(Client.id.in_(previous), Client.user_ref == user.id,
            Client.auth_state == "active").values(auth_state="pending", auth_version=Client.auth_version + 1,
            activated_at=None).execution_options(synchronize_session=False))
    return previous
