from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Any, Optional, List
import json
import os
import threading

from sqlalchemy import String, Text, create_engine, select, delete, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker
from sqlalchemy.types import JSON
from sqlalchemy.schema import ForeignKey

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

TEST_ANSWERS_FILE = DATA_DIR / "test_answers.json"
GROUPS_FILE = DATA_DIR / "groups.json"


@dataclass
class SessionData:
    session_id: str
    test_id: str
    file_path: str
    user_id: Optional[str]
    task: Optional[str]
    stats: Dict[str, Any]


class Base(DeclarativeBase):
    pass


class TestRecord(Base):
    __tablename__ = "tests"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    note: Mapped[Optional[str]] = mapped_column(Text(), nullable=True)


class TaskRecord(Base):
    __tablename__ = "tasks"

    test_id: Mapped[str] = mapped_column(
        String(100),
        ForeignKey("tests.id", ondelete="CASCADE"),
        primary_key=True,
    )
    id: Mapped[str] = mapped_column(String(100), primary_key=True)


class SessionRecord(Base):
    __tablename__ = "sessions"

    session_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    test_id: Mapped[str] = mapped_column(
        String(100),
        ForeignKey("tests.id", ondelete="RESTRICT"),
        index=True,
        default="TEST",
    )
    file_path: Mapped[str] = mapped_column(Text())
    user_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    task: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    stats: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)


class TestAnswerRecord(Base):
    __tablename__ = "test_answers"

    test_id: Mapped[str] = mapped_column(
        String(100),
        ForeignKey("tests.id", ondelete="CASCADE"),
        primary_key=True,
    )
    task_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    answer: Mapped[str] = mapped_column(Text())


class GroupRecord(Base):
    __tablename__ = "groups"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    test_id: Mapped[str] = mapped_column(
        String(100),
        ForeignKey("tests.id", ondelete="CASCADE"),
        index=True,
        default="TEST",
    )
    name: Mapped[str] = mapped_column(String(255))
    note: Mapped[Optional[str]] = mapped_column(Text(), nullable=True)

    session_links: Mapped[List["GroupSessionRecord"]] = relationship(
        back_populates="group",
        cascade="all, delete-orphan",
    )


class GroupSessionRecord(Base):
    __tablename__ = "group_sessions"

    group_id: Mapped[str] = mapped_column(
        String(100),
        ForeignKey("groups.id", ondelete="CASCADE"),
        primary_key=True,
    )
    session_id: Mapped[str] = mapped_column(
        String(255),
        ForeignKey("sessions.session_id", ondelete="CASCADE"),
        primary_key=True,
    )

    group: Mapped[GroupRecord] = relationship(back_populates="session_links")


def _build_database_url() -> str:
    configured_url = os.getenv("DATABASE_URL")
    if configured_url:
        return configured_url
    sqlite_path = DATA_DIR / "app.db"
    return f"sqlite:///{sqlite_path}"


DATABASE_URL = _build_database_url()
_engine_kwargs: Dict[str, Any] = {"future": True}
if DATABASE_URL.startswith("sqlite"):
    _engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, **_engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record) -> None:  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


def _normalize_test_answers_data(raw: Any) -> Dict[str, Dict[str, str]]:
    if not isinstance(raw, dict):
        return {}

    out: Dict[str, Dict[str, str]] = {}
    for test_id, answers in raw.items():
        if not isinstance(test_id, str):
            continue
        if not isinstance(answers, dict):
            continue

        out[test_id] = {}
        for task_id, val in answers.items():
            if not isinstance(task_id, str):
                continue
            if val is None:
                continue
            normalized_val = str(val).strip()
            if normalized_val:
                out[test_id][task_id] = normalized_val
    return out


def _load_test_answers_from_json() -> Dict[str, Dict[str, str]]:
    if not TEST_ANSWERS_FILE.exists():
        return {}

    try:
        raw = json.loads(TEST_ANSWERS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

    return _normalize_test_answers_data(raw)


def _normalize_groups_data(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []

    out: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue

        group_id = str(item.get("id", "")).strip()
        test_id = str(item.get("test_id", "TEST")).strip() or "TEST"
        name = str(item.get("name", "")).strip()
        session_ids = item.get("session_ids")
        if not isinstance(session_ids, list):
            session_ids = []

        normalized_session_ids = []
        for session_id in session_ids:
            if isinstance(session_id, str) and session_id.strip():
                normalized_session_ids.append(session_id.strip())

        if not group_id or not name:
            continue

        out.append(
            {
                "id": group_id,
                "test_id": test_id,
                "name": name,
                "session_ids": normalized_session_ids,
            }
        )

    return out


def _load_groups_from_json() -> List[Dict[str, Any]]:
    if not GROUPS_FILE.exists():
        return []

    try:
        raw = json.loads(GROUPS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []

    return _normalize_groups_data(raw)


def _ensure_test(db, test_id: str) -> None:
    if not db.get(TestRecord, test_id):
        db.add(TestRecord(id=test_id, name=None))


def _ensure_task(db, test_id: str, task_id: str) -> None:
    _ensure_test(db, test_id)
    if not db.get(TaskRecord, {"test_id": test_id, "id": task_id}):
        db.add(TaskRecord(test_id=test_id, id=task_id))


_migration_lock = threading.Lock()


def _migrate_json_seed_data() -> None:
    with _migration_lock:
        with SessionLocal() as db:
            answers_seed = _load_test_answers_from_json()
            groups_seed = _load_groups_from_json()

            all_test_ids = {"TEST"}
            all_test_ids.update(tid for tid in answers_seed.keys() if isinstance(tid, str) and tid.strip())
            all_test_ids.update(str(g.get("test_id") or "TEST").strip() or "TEST" for g in groups_seed)
            for test_id in all_test_ids:
                _ensure_test(db, test_id)
            db.flush()

            has_answers = db.execute(select(TestAnswerRecord).limit(1)).scalar_one_or_none() is not None
            if not has_answers:
                for test_id, answers in answers_seed.items():
                    for task_id, answer in answers.items():
                        _ensure_task(db, test_id, task_id)
                        db.add(TestAnswerRecord(test_id=test_id, task_id=task_id, answer=answer))
                db.flush()

            has_groups = db.execute(select(GroupRecord).limit(1)).scalar_one_or_none() is not None
            if not has_groups:
                for group in groups_seed:
                    normalized_test_id = str(group.get("test_id") or "TEST").strip() or "TEST"
                    db.add(
                        GroupRecord(
                            id=group["id"],
                            test_id=normalized_test_id,
                            name=group["name"],
                        )
                    )
                db.flush()

            db.commit()


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _ensure_schema_updates()
    _migrate_json_seed_data()

def _ensure_schema_updates() -> None:
    inspector = inspect(engine)

    test_columns = {col["name"] for col in inspector.get_columns("tests")}
    group_columns = {col["name"] for col in inspector.get_columns("groups")}

    with engine.begin() as conn:
        if "note" not in test_columns:
            conn.execute(text("ALTER TABLE tests ADD COLUMN note TEXT"))
        if "note" not in group_columns:
            conn.execute(text("ALTER TABLE groups ADD COLUMN note TEXT"))


class DatabaseStore:
    def __init__(self) -> None:
        init_db()

    def upsert(self, session: SessionData) -> None:
        payload_stats = session.stats if isinstance(session.stats, dict) else {}
        normalized_test_id = str(session.test_id or "TEST").strip() or "TEST"

        with SessionLocal() as db:
            _ensure_test(db, normalized_test_id)

            existing = db.get(SessionRecord, session.session_id)
            if existing:
                existing.test_id = normalized_test_id
                existing.file_path = session.file_path
                existing.user_id = session.user_id
                existing.task = session.task
                existing.stats = payload_stats
            else:
                db.add(
                    SessionRecord(
                        session_id=session.session_id,
                        test_id=normalized_test_id,
                        file_path=session.file_path,
                        user_id=session.user_id,
                        task=session.task,
                        stats=payload_stats,
                    )
                )
            db.commit()

    def get(self, session_id: str) -> Optional[SessionData]:
        with SessionLocal() as db:
            row = db.get(SessionRecord, session_id)
            if not row:
                return None
            return SessionData(
                session_id=row.session_id,
                test_id=row.test_id,
                file_path=row.file_path,
                user_id=row.user_id,
                task=row.task,
                stats=row.stats if isinstance(row.stats, dict) else {},
            )

    def list_sessions(self) -> Dict[str, SessionData]:
        with SessionLocal() as db:
            rows = db.execute(select(SessionRecord)).scalars().all()
            return {
                row.session_id: SessionData(
                    session_id=row.session_id,
                    test_id=row.test_id,
                    file_path=row.file_path,
                    user_id=row.user_id,
                    task=row.task,
                    stats=row.stats if isinstance(row.stats, dict) else {},
                )
                for row in rows
            }

def delete_sessions(self, test_id: str, session_ids: List[str]) -> int:
        normalized_test_id = str(test_id or "TEST").strip() or "TEST"
        normalized_ids = [str(sid).strip() for sid in session_ids if isinstance(sid, str) and str(sid).strip()]
        if not normalized_ids:
            return 0

        with SessionLocal() as db:
            rows = db.execute(
                select(SessionRecord).where(
                    SessionRecord.test_id == normalized_test_id,
                    SessionRecord.session_id.in_(normalized_ids),
                )
            ).scalars().all()

            for row in rows:
                db.delete(row)

            deleted_count = len(rows)
            db.commit()
            return deleted_count

def delete_all_sessions_for_test(self, test_id: str) -> int:
    normalized_test_id = str(test_id or "TEST").strip() or "TEST"

    with SessionLocal() as db:
        rows = db.execute(
            select(SessionRecord).where(SessionRecord.test_id == normalized_test_id)
        ).scalars().all()

        for row in rows:
            db.delete(row)

        deleted_count = len(rows)
        db.commit()
        return deleted_count


STORE = DatabaseStore()

def delete_sessions(test_id: str, session_ids: List[str]) -> int:
    normalized_test_id = str(test_id or "TEST").strip() or "TEST"
    normalized_ids = [str(sid).strip() for sid in session_ids if isinstance(sid, str) and str(sid).strip()]
    if not normalized_ids:
        return 0

    with SessionLocal() as db:
        rows = db.execute(
            select(SessionRecord).where(
                SessionRecord.test_id == normalized_test_id,
                SessionRecord.session_id.in_(normalized_ids),
            )
        ).scalars().all()

        for row in rows:
            db.delete(row)

        deleted_count = len(rows)
        db.commit()
        return deleted_count

def delete_all_sessions_for_test(test_id: str) -> int:
    normalized_test_id = str(test_id or "TEST").strip() or "TEST"

    with SessionLocal() as db:
        rows = db.execute(
            select(SessionRecord).where(SessionRecord.test_id == normalized_test_id)
        ).scalars().all()

        for row in rows:
            db.delete(row)

        deleted_count = len(rows)
        db.commit()
        return deleted_count

def ensure_upload_dir() -> Path:
    p = Path("data/uploads")
    p.mkdir(parents=True, exist_ok=True)
    return p


def get_test_answers(test_id: str) -> Dict[str, str]:
    normalized_test_id = str(test_id or "TEST").strip() or "TEST"
    with SessionLocal() as db:
        rows = db.execute(
            select(TestAnswerRecord).where(TestAnswerRecord.test_id == normalized_test_id)
        ).scalars().all()
        return {row.task_id: row.answer for row in rows}


def set_test_answer(test_id: str, task_id: str, answer: Optional[str]) -> Dict[str, str]:
    normalized_test_id = str(test_id or "TEST").strip() or "TEST"
    normalized_task_id = str(task_id or "unknown").strip() or "unknown"

    with SessionLocal() as db:
        _ensure_task(db, normalized_test_id, normalized_task_id)

        row = db.get(TestAnswerRecord, {"test_id": normalized_test_id, "task_id": normalized_task_id})
        if answer is None:
            if row:
                db.delete(row)
        else:
            normalized_answer = str(answer).strip()
            if not normalized_answer:
                if row:
                    db.delete(row)
            else:
                if row:
                    row.answer = normalized_answer
                else:
                    db.add(
                        TestAnswerRecord(
                            test_id=normalized_test_id,
                            task_id=normalized_task_id,
                            answer=normalized_answer,
                        )
                    )

        db.commit()

        rows = db.execute(
            select(TestAnswerRecord).where(TestAnswerRecord.test_id == normalized_test_id)
        ).scalars().all()
        return {item.task_id: item.answer for item in rows}


def list_groups(test_id: Optional[str] = None) -> List[Dict[str, Any]]:
    with SessionLocal() as db:
        stmt = select(GroupRecord)
        if isinstance(test_id, str) and test_id.strip():
            stmt = stmt.where(GroupRecord.test_id == test_id.strip())

        groups = db.execute(stmt).scalars().all()

        out: List[Dict[str, Any]] = []
        for group in groups:
            session_ids = [link.session_id for link in group.session_links]
            out.append(
                {
                    "id": group.id,
                    "test_id": group.test_id,
                    "name": group.name,
                    "note": group.note,
                    "session_ids": session_ids,
                }
            )

        return out


def upsert_group(group_id: str, test_id: str, name: str, session_ids: List[str]) -> Dict[str, Any]:
    normalized_group_id = str(group_id or "").strip()
    normalized_test_id = str(test_id or "TEST").strip() or "TEST"
    normalized_name = str(name or "").strip()

    normalized_session_ids = []
    for session_id in session_ids:
        if isinstance(session_id, str) and session_id.strip():
            normalized_session_ids.append(session_id.strip())

    if not normalized_group_id:
        raise ValueError("group_id is required")
    if not normalized_name:
        raise ValueError("name is required")

    deduplicated_session_ids = list(dict.fromkeys(normalized_session_ids))

    with SessionLocal() as db:
        _ensure_test(db, normalized_test_id)

        if deduplicated_session_ids:
            existing_ids = set(
                db.execute(
                    select(SessionRecord.session_id).where(SessionRecord.session_id.in_(deduplicated_session_ids))
                ).scalars().all()
            )
            missing_ids = [sid for sid in deduplicated_session_ids if sid not in existing_ids]
            if missing_ids:
                raise ValueError(f"session_ids not found: {', '.join(missing_ids)}")

            wrong_test_ids = db.execute(
                select(SessionRecord.session_id).where(
                    SessionRecord.session_id.in_(deduplicated_session_ids),
                    SessionRecord.test_id != normalized_test_id,
                )
            ).scalars().all()
            if wrong_test_ids:
                raise ValueError("All session_ids must belong to the same test_id as the group")

        group = db.get(GroupRecord, normalized_group_id)
        if not group:
            group = GroupRecord(
                id=normalized_group_id,
                test_id=normalized_test_id,
                name=normalized_name,
            )
            db.add(group)
            db.flush()
        else:
            group.test_id = normalized_test_id
            group.name = normalized_name

        db.execute(delete(GroupSessionRecord).where(GroupSessionRecord.group_id == normalized_group_id))
        for sid in deduplicated_session_ids:
            db.add(GroupSessionRecord(group_id=normalized_group_id, session_id=sid))

        db.commit()
    
    with SessionLocal() as db:
        latest = db.get(GroupRecord, normalized_group_id)
        note = latest.note if latest else None

    return {
        "id": normalized_group_id,
        "test_id": normalized_test_id,
        "name": normalized_name,
        "note": note,
        "session_ids": deduplicated_session_ids,
    }


def get_test_settings(test_id: str) -> Dict[str, Optional[str]]:
    normalized_test_id = str(test_id or "TEST").strip() or "TEST"
    with SessionLocal() as db:
        _ensure_test(db, normalized_test_id)
        db.commit()
        row = db.get(TestRecord, normalized_test_id)
        return {
            "name": row.name if row else None,
            "note": row.note if row else None,
        }


def update_test_settings(test_id: str, name: Optional[str], note: Optional[str]) -> Dict[str, Optional[str]]:
    normalized_test_id = str(test_id or "TEST").strip() or "TEST"
    normalized_name = str(name).strip() if name is not None else None
    normalized_note = str(note) if note is not None else None

    with SessionLocal() as db:
        _ensure_test(db, normalized_test_id)
        row = db.get(TestRecord, normalized_test_id)
        if row:
            row.name = normalized_name if normalized_name else None
            row.note = normalized_note
        db.commit()
        return {
            "name": row.name if row else None,
            "note": row.note if row else None,
        }


def delete_test(test_id: str) -> bool:
    normalized_test_id = str(test_id or "TEST").strip() or "TEST"
    with SessionLocal() as db:
        row = db.get(TestRecord, normalized_test_id)
        if not row:
            return False
        db.delete(row)
        db.commit()
        return True


def update_group_settings(group_id: str, name: Optional[str], note: Optional[str]) -> Dict[str, Any]:
    normalized_group_id = str(group_id or "").strip()
    if not normalized_group_id:
        raise ValueError("group_id is required")

    with SessionLocal() as db:
        group = db.get(GroupRecord, normalized_group_id)
        if not group:
            raise ValueError("Skupina nenalezena.")

        if name is not None:
            normalized_name = str(name).strip()
            if not normalized_name:
                raise ValueError("name is required")
            group.name = normalized_name

        if note is not None:
            group.note = str(note)

        db.commit()

        return {
            "id": group.id,
            "test_id": group.test_id,
            "name": group.name,
            "note": group.note,
            "session_ids": [link.session_id for link in group.session_links],
        }


def delete_group(group_id: str) -> bool:
    normalized_group_id = str(group_id or "").strip()
    if not normalized_group_id:
        return False
    with SessionLocal() as db:
        group = db.get(GroupRecord, normalized_group_id)
        if not group:
            return False
        db.delete(group)
        db.commit()
        return True