# FIESTA Backend

FastAPI-based backend for the EarthRef.org FIESTA API.

## Features

- **RESTful API** built with FastAPI
- **Asynchronous** database access with SQLAlchemy 2.0
- **JWT-based authentication** with OAuth2
- **PostgreSQL** database with async support
- **Alembic** for database migrations
- **Pydantic** for data validation and settings management
- **Testing** with pytest and pytest-asyncio
- **Documentation** with OpenAPI and Stoplight Elements
- **Linting** with Ruff
- **Code formatting** with Black and isort

## Prerequisites

- Python 3.10+
- PostgreSQL 13+
- UV package manager (recommended) or pip

## Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/earthref/FIESTA.git
   cd FIESTA/backend
   ```

2. **Install UV** (recommended package manager)
   ```bash
   curl -sSf https://astral.sh/uv/install.sh | sh
   ```

3. **Create and activate a virtual environment**
   ```bash
   uv venv
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   ```

4. **Install dependencies**
   ```bash
   uv pip install -e ".[dev]"
   ```

5. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   Update the values in `.env` as needed, especially the database connection settings.

6. **Set up the database**
   - Create a PostgreSQL database
   - Update the `DATABASE_URL` in `.env` with your database credentials
   - Run the database initialization script:
     ```bash
     python -m scripts.init_db
     ```

7. **Run database migrations** (if needed)
   ```bash
   alembic upgrade head
   ```

## Running the Application

### Development Server

```bash
python -m scripts.run
```

Or with auto-reload:

```bash
uvicorn app.main:app --reload
```

The API will be available at http://localhost:8000

### Production

For production, use a production-grade ASGI server like Uvicorn with Gunicorn:

```bash
gunicorn -k uvicorn.workers.UvicornWorker app.main:app
```

## API Documentation

Once the server is running, you can access the API documentation at:

- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc
- **Stoplight Elements**: http://localhost:8000/api-docs

## Testing

Run tests with:

```bash
pytest
```

Run tests with coverage:

```bash
pytest --cov=app --cov-report=term-missing
```

## Linting and Formatting

- **Lint code** with Ruff:
  ```bash
  ruff check .
  ```

- **Format code** with Black and isort:
  ```bash
  black .
  isort .
  ```

- **Type checking** with mypy:
  ```bash
  mypy .
  ```

## Database Migrations

When you make changes to the database models, you'll need to create and apply migrations:

1. **Create a new migration**:
   ```bash
   alembic revision --autogenerate -m "Description of changes"
   ```

2. **Apply migrations**:
   ```bash
   alembic upgrade head
   ```

## Project Structure

```
backend/
├── alembic/               # Database migration scripts
├── app/                   # Application code
│   ├── api/               # API routes
│   │   └── v1/            # API version 1
│   │       ├── endpoints/  # Route handlers
│   │       └── deps.py    # Dependencies
│   ├── core/              # Core functionality
│   │   ├── config.py      # Configuration
│   │   └── security.py    # Authentication and security
│   ├── db/                # Database models and sessions
│   │   ├── models/        # SQLAlchemy models
│   │   └── session.py     # Database session management
│   ├── schemas/           # Pydantic models
│   └── services/          # Business logic
├── scripts/               # Utility scripts
├── tests/                 # Test files
├── .env.example           # Example environment variables
├── .gitignore
├── alembic.ini            # Alembic configuration
├── pyproject.toml         # Project configuration
└── README.md              # This file
```

## Environment Variables

Key environment variables:

- `APP_ENV`: Application environment (development, production, test)
- `DATABASE_URL`: Database connection URL
- `SECRET_KEY`: Secret key for JWT token generation
- `ALGORITHM`: Algorithm for JWT (default: HS256)
- `ACCESS_TOKEN_EXPIRE_MINUTES`: Token expiration time in minutes
- `AWS_*`: AWS credentials for S3 storage (if used)
- `ELASTICSEARCH_HOST`: URL for Elasticsearch (if used)

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgements

- [FastAPI](https://fastapi.tiangolo.com/)
- [SQLAlchemy](https://www.sqlalchemy.org/)
- [Alembic](https://alembic.sqlalchemy.org/)
- [Pydantic](https://pydantic-docs.helpmanual.io/)
- [UV](https://github.com/astral-sh/uv)
