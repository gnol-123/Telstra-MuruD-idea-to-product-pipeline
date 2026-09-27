FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN useradd --create-home --uid 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Empty host = IPv4 and IPv6 sockets. Not ::, asyncio makes that IPv6 only and
# Railway's healthcheck is IPv4; legacy private networking is IPv6 only
CMD ["sh", "-c", "uvicorn app.main:app --host '' --port ${PORT:-8000}"]
