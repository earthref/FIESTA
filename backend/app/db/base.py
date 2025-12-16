"""
Base database model with common functionality.
"""
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import Column, DateTime, Integer
from sqlalchemy.ext.declarative import as_declarative, declared_attr
from sqlalchemy.sql import func

from app.db.session import Base

class BaseModel(Base):
    """Base model with common fields and methods."""
    __abstract__ = True

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), nullable=True)

    def to_dict(self, exclude: Optional[list] = None) -> Dict[str, Any]:
        """Convert model to dictionary.
        
        Args:
            exclude: List of field names to exclude from the result.
            
        Returns:
            Dictionary representation of the model.
        """
        if exclude is None:
            exclude = []
            
        return {
            column.name: getattr(self, column.name)
            for column in self.__table__.columns
            if column.name not in exclude
        }

    @classmethod
    def get_table_name(cls) -> str:
        """Get the table name for the model."""
        return cls.__tablename__

    def __repr__(self) -> str:
        """String representation of the model."""
        return f"<{self.__class__.__name__}(id={self.id})>"
