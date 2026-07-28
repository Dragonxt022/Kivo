ALTER TABLE purchases ADD COLUMN payment_method_id INTEGER REFERENCES payment_methods(id);
ALTER TABLE purchases ADD COLUMN installment_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE purchases ADD COLUMN first_due_date TEXT;
