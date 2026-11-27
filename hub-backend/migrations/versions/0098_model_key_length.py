"""Widen model provider API keys so long vendor credentials fit.

The 400-character cap rejected long API keys (some vendor credentials exceed it),
so the column and its HTTP validation now allow 4000 characters.
"""
from alembic import op
import sqlalchemy as sa


revision = "0098_model_key_length"
down_revision = "0097_model_advertised_window"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("model_provider") as batch:
        batch.alter_column("api_key", existing_type=sa.String(length=400),
                           type_=sa.String(length=4000), existing_nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("model_provider") as batch:
        batch.alter_column("api_key", existing_type=sa.String(length=4000),
                           type_=sa.String(length=400), existing_nullable=False)
