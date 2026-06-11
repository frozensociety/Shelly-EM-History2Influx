class HttpError extends Error {
    statusCode: number;

    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'HttpError'; // Important for instanceof checks

        // Fix prototype chain for instanceof to work correctly in TypeScript/ES6
        Object.setPrototypeOf(this, HttpError.prototype);
    }
}

export default HttpError;