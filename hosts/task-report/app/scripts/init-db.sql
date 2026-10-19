CREATE ROLE taskapp_owner LOGIN PASSWORD 'dev-only-owner-password';
CREATE ROLE taskapp_app LOGIN PASSWORD 'dev-only-app-password';
CREATE DATABASE taskapp OWNER taskapp_owner;
