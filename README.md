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
    DB_HOST=localhost
    DB_PORT=3306
    DB_USER=root
    DB_PASSWORD=password
    DB_NAME=auto_box
    PORT=3001
    NODE_ENV=development
    WEBPAY_COMMERCE_CODE=your_commerce_code
    WEBPAY_API_KEY=your_api_key
    ```

3.  Run the application:
    ```bash
    npm run start:dev
    ```

## API Documentation

Swagger UI is available at `http://localhost:3001/api`.

### Endpoints

-   `POST /create`: Create a new Webpay transaction.
-   `POST /commit`: Commit a Webpay transaction.
-   `POST /status`: Get the status of a Webpay transaction.
-   `POST /refund`: Refund a Webpay transaction.

## Database Integration

This service interacts with the `webpay_plus_transaccion` table in the `auto_box` database. It automatically saves transaction details upon creation and updates them on commit/status checks.
