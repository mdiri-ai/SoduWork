"""Widen model provider API keys so long vendor credentials fit.

The 400-character cap rejected long API keys (some vendor credentials exceed it),
so the column and its HTTP validation now allow 4000 characters.
"""
from alembic import op
from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa

revision = "0098_model_key_length"
down_revision = "0097_model_advertised_window"
branch_labels = None
depends_on = None


def migrate_schema(connection) -> None:
    """Also used before stamping an unversioned database at the current head."""
    insp = sa.inspect(connection)
    if not insp.has_table("model_provider"):
        return  # The table may be absent in an incomplete legacy schema.
    columns = {item["name"]: item for item in insp.get_columns("model_provider")}
    if "api_key" not in columns:
        return
    existing = columns["api_key"]["type"]
    if getattr(existing, "length", None) == 4000:
        return
    if connection.dialect.name == "postgresql":
        connection.execute(sa.text(
            "ALTER TABLE model_provider ALTER COLUMN api_key TYPE VARCHAR(4000)"))
        return
    # SQLite reflects the declared length, which alembic check compares even though
    # it never enforces it; rebuild the table so adopted databases match the metadata.
    with Operations.context(MigrationContext.configure(connection)) as batch_ops:
        with batch_ops.batch_alter_table("model_provider") as batch:
            batch.alter_column("api_key", existing_type=existing,
                               type_=sa.String(length=4000), existing_nullable=False)


def upgrade() -> None:
    migrate_schema(op.get_bind())


def downgrade() -> None:
    with op.batch_alter_table("model_provider") as batch:
        batch.alter_column("api_key", existing_type=sa.String(length=4000),
                           type_=sa.String(length=400), existing_nullable=False)
