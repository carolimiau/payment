# Payment Service Refactored

This is a refactored version of the Payment Service using NestJS and TypeORM, integrated with the new database schema.

## Setup

1.  Install dependencies:
    ```bash
    npm install
    ```

2.  Configure environment variables:
    Copy `.env.example` to `.env` (or create one) and set the following variables:
    ```dotenv
    MYSQLHOST=localhost
    MYSQLPORT=3306
    MYSQLUSER=root
    MYSQLPASSWORD=password
    MYSQLDATABASE=auto_box
    PORT=3001
    TBK_ENV=INTEGRATION
    TBK_COMMERCE_CODE=
    TBK_API_KEY_SECRET=
    TBK_RETURN_URL=
    ```

    Notes:
    - For `TBK_ENV=INTEGRATION`, the service uses Transbank integration credentials automatically.
    - `TBK_COMMERCE_CODE`, `TBK_API_KEY_SECRET`, and an HTTPS `TBK_RETURN_URL` are required for `TBK_ENV=PRODUCTION`.
    - Do not use `TBK_ENV=PRODUCTION` with integration/test credentials.

3.  Run the application:
    ```bash
    npm run start:dev
    ```

## API Documentation

Swagger UI is available at `http://localhost:3001/api`.

### Endpoints

-   `POST /create`: Create a new Webpay transaction.
-   `POST /commit`: Commit a Webpay transaction callback.
-   `GET /commit`: Fallback callback endpoint for Webpay return.
-   `POST /status`: Get the status of a Webpay transaction.
-   `POST /refund`: Refund a Webpay transaction.

## Database Integration

This service interacts with the `webpay_plus_transaccion` table in the `auto_box` database. It automatically saves transaction details upon creation and updates them on commit/status checks.
