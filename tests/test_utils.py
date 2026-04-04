"""Tests for utils module."""

import pytest
from utils import greet, add, multiply


def test_greet():
    assert greet("World") == "Hello, World!"
    assert greet("Alice") == "Hello, Alice!"


def test_add():
    assert add(2, 3) == 5
    assert add(-1, 1) == 0
    assert add(0, 0) == 0


def test_multiply():
    assert multiply(2, 3) == 6
    assert multiply(-2, 3) == -6
    assert multiply(0, 100) == 0
