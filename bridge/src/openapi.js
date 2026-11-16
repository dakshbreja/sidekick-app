// GENERATED — do not edit by hand.
// Rebuild with: node scripts/build-openapi.mjs
// Source of truth: gpt-action-schema.yaml

export default {
  "openapi": "3.1.0",
  "info": {
    "title": "Daksh Course Status",
    "description": "Live Fall 2026 coursework status, read fresh from eLC and Google Calendar on every call.",
    "version": "1.4.0"
  },
  "servers": [
    {
      "url": "https://ijuh2yp6rf.example-subdomain.workers.dev"
    }
  ],
  "security": [
    {
      "bearerAuth": []
    }
  ],
  "paths": {
    "/learner/tools/start_practice_item": {
      "post": {
        "operationId": "startPracticeItem",
        "summary": "start practice item",
        "description": "Record the actual question/options, versioned source and student-stated confidence BEFORE asking for or accepting an answer. Null confidence means not stated. Persist and read back revision 1 before continuing. No retroactive confidence imports.",
        "x-openai-isConsequential": true,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "course": {
                    "type": "string",
                    "enum": [
                      "BUSN5000",
                      "MGMT4280",
                      "MGMT5560",
                      "MGMT5850",
                      "LAND2510",
                      "BUSN3040"
                    ]
                  },
                  "term_id": {
                    "type": "string",
                    "enum": [
                      "fall-2026"
                    ]
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false
                  },
                  "expected_revision": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "idempotency_key": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160
                  },
                  "item": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "item_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160
                      },
                      "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160
                      },
                      "source": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "material_id": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160
                          },
                          "revision": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 100
                          },
                          "url": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 1000
                          },
                          "locator": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200
                          }
                        },
                        "required": [
                          "material_id",
                          "revision",
                          "url"
                        ]
                      },
                      "question": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2000
                      },
                      "options": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": 8,
                        "items": {
                          "type": "object",
                          "additionalProperties": false,
                          "properties": {
                            "id": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 160
                            },
                            "text": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 600
                            },
                            "distractor_type": {
                              "type": "string",
                              "enum": [
                                "concept_confusion",
                                "calculation",
                                "sign",
                                "units",
                                "reading",
                                "unspecified"
                              ]
                            }
                          },
                          "required": [
                            "id",
                            "text"
                          ]
                        }
                      },
                      "confidence": {
                        "type": [
                          "integer",
                          "null"
                        ],
                        "minimum": 0,
                        "maximum": 100
                      },
                      "confidence_stated_at": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 40
                      },
                      "recording_agent": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 80
                      },
                      "review_of": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160
                      }
                    },
                    "required": [
                      "item_id",
                      "session_id",
                      "source",
                      "question",
                      "options",
                      "confidence",
                      "confidence_stated_at",
                      "recording_agent"
                    ]
                  }
                },
                "required": [
                  "course",
                  "expected_revision",
                  "idempotency_key",
                  "item"
                ]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Authenticated learner result; mutations require exact readback.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "item_count": {
                      "type": "integer"
                    },
                    "items": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "hypotheses": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "outcomes": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "reviews": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    }
                  },
                  "additionalProperties": true
                }
              }
            }
          },
          "400": {
            "description": "Invalid request; inspect exact errors."
          },
          "401": {
            "description": "Existing authorized school connection required."
          },
          "403": {
            "description": "Scope or explicit student instruction required."
          },
          "409": {
            "description": "Revision/idempotency conflict; reread before another operation."
          },
          "503": {
            "description": "Unconfirmed. Retry the unchanged packet/key or inspect exact record."
          }
        }
      }
    },
    "/learner/tools/answer_practice_item": {
      "post": {
        "operationId": "answerPracticeItem",
        "summary": "answer practice item",
        "description": "Finish a started item once with chosen answer, source-backed answer key, help actually used and timestamp. Confidence must already have a server receipt. Immutable after answer; correctness is exact option-ID equality, never mastery.",
        "x-openai-isConsequential": true,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "course": {
                    "type": "string",
                    "enum": [
                      "BUSN5000",
                      "MGMT4280",
                      "MGMT5560",
                      "MGMT5850",
                      "LAND2510",
                      "BUSN3040"
                    ]
                  },
                  "term_id": {
                    "type": "string",
                    "enum": [
                      "fall-2026"
                    ]
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false
                  },
                  "expected_revision": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "idempotency_key": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160
                  },
                  "answer": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "item_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160
                      },
                      "chosen_answer": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160
                      },
                      "correct_answer": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160
                      },
                      "answer_source": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "material_id": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160
                          },
                          "revision": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 100
                          },
                          "url": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 1000
                          },
                          "locator": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200
                          }
                        },
                        "required": [
                          "material_id",
                          "revision",
                          "url"
                        ]
                      },
                      "help_level": {
                        "type": "string",
                        "enum": [
                          "none",
                          "hint",
                          "worked_example",
                          "answer_shown"
                        ]
                      },
                      "answered_at": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 40
                      },
                      "recording_agent": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 80
                      }
                    },
                    "required": [
                      "item_id",
                      "chosen_answer",
                      "correct_answer",
                      "answer_source",
                      "help_level",
                      "answered_at",
                      "recording_agent"
                    ]
                  }
                },
                "required": [
                  "course",
                  "expected_revision",
                  "idempotency_key",
                  "answer"
                ]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Authenticated learner result; mutations require exact readback.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "item_count": {
                      "type": "integer"
                    },
                    "items": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "hypotheses": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "outcomes": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "reviews": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    }
                  },
                  "additionalProperties": true
                }
              }
            }
          },
          "400": {
            "description": "Invalid request; inspect exact errors."
          },
          "401": {
            "description": "Existing authorized school connection required."
          },
          "403": {
            "description": "Scope or explicit student instruction required."
          },
          "409": {
            "description": "Revision/idempotency conflict; reread before another operation."
          },
          "503": {
            "description": "Unconfirmed. Retry the unchanged packet/key or inspect exact record."
          }
        }
      }
    },
    "/learner/tools/read_practice_items": {
      "post": {
        "operationId": "readPracticeItems",
        "summary": "read practice items",
        "description": "Read recorded practice items by exact course/term/real-test scope; follow next_offset. No judgments. Exact item_id returns the complete item.",
        "x-openai-isConsequential": false,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "course": {
                    "type": "string",
                    "enum": [
                      "BUSN5000",
                      "MGMT4280",
                      "MGMT5560",
                      "MGMT5850",
                      "LAND2510",
                      "BUSN3040"
                    ]
                  },
                  "term_id": {
                    "type": "string",
                    "enum": [
                      "fall-2026"
                    ]
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false
                  },
                  "item_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160
                  },
                  "outcome_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160
                  },
                  "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100
                  },
                  "offset": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": []
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Authenticated learner result; mutations require exact readback.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "item_count": {
                      "type": "integer"
                    },
                    "items": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "hypotheses": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "outcomes": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "reviews": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    }
                  },
                  "additionalProperties": true
                }
              }
            }
          },
          "400": {
            "description": "Invalid request; inspect exact errors."
          },
          "401": {
            "description": "Existing authorized school connection required."
          },
          "403": {
            "description": "Scope or explicit student instruction required."
          },
          "409": {
            "description": "Revision/idempotency conflict; reread before another operation."
          },
          "503": {
            "description": "Unconfirmed. Retry the unchanged packet/key or inspect exact record."
          }
        }
      }
    },
    "/learner/tools/read_learner_profile": {
      "post": {
        "operationId": "readLearnerProfile",
        "summary": "read learner profile",
        "description": "At course-session start after PASS, read same-course aggregates, evidence-linked hypotheses, reviews and private outcomes. Hypotheses are never facts or mastery. Never auto-confirm/reject; status changes require Daksh\u2019s explicit instruction.",
        "x-openai-isConsequential": false,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "course": {
                    "type": "string",
                    "enum": [
                      "BUSN5000",
                      "MGMT4280",
                      "MGMT5560",
                      "MGMT5850",
                      "LAND2510",
                      "BUSN3040"
                    ]
                  },
                  "term_id": {
                    "type": "string",
                    "enum": [
                      "fall-2026"
                    ]
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false
                  },
                  "item_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160
                  },
                  "outcome_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160
                  },
                  "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100
                  },
                  "offset": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": []
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Authenticated learner result; mutations require exact readback.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "item_count": {
                      "type": "integer"
                    },
                    "items": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "hypotheses": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "outcomes": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "reviews": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    }
                  },
                  "additionalProperties": true
                }
              }
            }
          },
          "400": {
            "description": "Invalid request; inspect exact errors."
          },
          "401": {
            "description": "Existing authorized school connection required."
          },
          "403": {
            "description": "Scope or explicit student instruction required."
          },
          "409": {
            "description": "Revision/idempotency conflict; reread before another operation."
          },
          "503": {
            "description": "Unconfirmed. Retry the unchanged packet/key or inspect exact record."
          }
        }
      }
    },
    "/learner/tools/read_hypotheses": {
      "post": {
        "operationId": "readHypotheses",
        "summary": "read hypotheses",
        "description": "Read evidence-derived hypotheses and student-set statuses. Patterns remain hypotheses, never facts or mastery.",
        "x-openai-isConsequential": false,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "course": {
                    "type": "string",
                    "enum": [
                      "BUSN5000",
                      "MGMT4280",
                      "MGMT5560",
                      "MGMT5850",
                      "LAND2510",
                      "BUSN3040"
                    ]
                  },
                  "term_id": {
                    "type": "string",
                    "enum": [
                      "fall-2026"
                    ]
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false
                  }
                },
                "required": []
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Authenticated learner result; mutations require exact readback.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "item_count": {
                      "type": "integer"
                    },
                    "items": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "hypotheses": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "outcomes": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "reviews": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    }
                  },
                  "additionalProperties": true
                }
              }
            }
          },
          "400": {
            "description": "Invalid request; inspect exact errors."
          },
          "401": {
            "description": "Existing authorized school connection required."
          },
          "403": {
            "description": "Scope or explicit student instruction required."
          },
          "409": {
            "description": "Revision/idempotency conflict; reread before another operation."
          },
          "503": {
            "description": "Unconfirmed. Retry the unchanged packet/key or inspect exact record."
          }
        }
      }
    },
    "/learner/tools/read_review_items": {
      "post": {
        "operationId": "readReviewItems",
        "summary": "read review items",
        "description": "Read due retrieval-practice items and exact supporting evidence. Ask a question before hints or re-explanation.",
        "x-openai-isConsequential": false,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "course": {
                    "type": "string",
                    "enum": [
                      "BUSN5000",
                      "MGMT4280",
                      "MGMT5560",
                      "MGMT5850",
                      "LAND2510",
                      "BUSN3040"
                    ]
                  },
                  "term_id": {
                    "type": "string",
                    "enum": [
                      "fall-2026"
                    ]
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false
                  }
                },
                "required": []
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Authenticated learner result; mutations require exact readback.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "item_count": {
                      "type": "integer"
                    },
                    "items": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "hypotheses": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "outcomes": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "reviews": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    }
                  },
                  "additionalProperties": true
                }
              }
            }
          },
          "400": {
            "description": "Invalid request; inspect exact errors."
          },
          "401": {
            "description": "Existing authorized school connection required."
          },
          "403": {
            "description": "Scope or explicit student instruction required."
          },
          "409": {
            "description": "Revision/idempotency conflict; reread before another operation."
          },
          "503": {
            "description": "Unconfirmed. Retry the unchanged packet/key or inspect exact record."
          }
        }
      }
    },
    "/learner/tools/set_hypothesis_status": {
      "post": {
        "operationId": "setHypothesisStatus",
        "summary": "set hypothesis status",
        "description": "Relay Daksh\u2019s explicit instruction naming this hypothesis and desired status. Never infer approval, confirm automatically, or apply an outcome suggestion. Preserve source/message reference and exact words; per-call student approval is required.",
        "x-openai-isConsequential": true,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "course": {
                    "type": "string",
                    "enum": [
                      "BUSN5000",
                      "MGMT4280",
                      "MGMT5560",
                      "MGMT5850",
                      "LAND2510",
                      "BUSN3040"
                    ]
                  },
                  "term_id": {
                    "type": "string",
                    "enum": [
                      "fall-2026"
                    ]
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false
                  },
                  "expected_revision": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "idempotency_key": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160
                  },
                  "hypothesis_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "open",
                      "confirmed",
                      "rejected",
                      "ignored"
                    ]
                  },
                  "student_instruction": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "text": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 600
                      },
                      "source": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 300
                      },
                      "recording_agent": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 80
                      }
                    },
                    "required": [
                      "text",
                      "source",
                      "recording_agent"
                    ]
                  }
                },
                "required": [
                  "course",
                  "expected_revision",
                  "idempotency_key",
                  "hypothesis_id",
                  "status",
                  "student_instruction"
                ]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Authenticated learner result; mutations require exact readback.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "item_count": {
                      "type": "integer"
                    },
                    "items": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "hypotheses": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "outcomes": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "reviews": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    }
                  },
                  "additionalProperties": true
                }
              }
            }
          },
          "400": {
            "description": "Invalid request; inspect exact errors."
          },
          "401": {
            "description": "Existing authorized school connection required."
          },
          "403": {
            "description": "Scope or explicit student instruction required."
          },
          "409": {
            "description": "Revision/idempotency conflict; reread before another operation."
          },
          "503": {
            "description": "Unconfirmed. Retry the unchanged packet/key or inspect exact record."
          }
        }
      }
    },
    "/learner/tools/save_grade_outcome": {
      "post": {
        "operationId": "saveGradeOutcome",
        "summary": "save grade outcome",
        "description": "Save an explicitly student-reported assessment outcome in the separate private outcomes layer. Always reported. Never put grades into PASS or shared status. Portal verification requires the owner original-eLC-read import flow.",
        "x-openai-isConsequential": true,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "course": {
                    "type": "string",
                    "enum": [
                      "BUSN5000",
                      "MGMT4280",
                      "MGMT5560",
                      "MGMT5850",
                      "LAND2510",
                      "BUSN3040"
                    ]
                  },
                  "term_id": {
                    "type": "string",
                    "enum": [
                      "fall-2026"
                    ]
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false
                  },
                  "expected_revision": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "idempotency_key": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160
                  },
                  "outcome": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "outcome_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160
                      },
                      "assessment_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160
                      },
                      "assessment": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      },
                      "assessed_at": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 40
                      },
                      "earned": {
                        "type": "number",
                        "minimum": 0
                      },
                      "possible": {
                        "type": "number",
                        "exclusiveMinimum": 0
                      },
                      "hypothesis_ids": {
                        "type": "array",
                        "maxItems": 20,
                        "uniqueItems": true,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160
                        }
                      },
                      "reported_by": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 80
                      }
                    },
                    "required": [
                      "outcome_id",
                      "assessment_id",
                      "assessment",
                      "assessed_at",
                      "earned",
                      "possible",
                      "hypothesis_ids",
                      "reported_by"
                    ]
                  }
                },
                "required": [
                  "course",
                  "expected_revision",
                  "idempotency_key",
                  "outcome"
                ]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Authenticated learner result; mutations require exact readback.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "item_count": {
                      "type": "integer"
                    },
                    "items": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "hypotheses": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "outcomes": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "reviews": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    }
                  },
                  "additionalProperties": true
                }
              }
            }
          },
          "400": {
            "description": "Invalid request; inspect exact errors."
          },
          "401": {
            "description": "Existing authorized school connection required."
          },
          "403": {
            "description": "Scope or explicit student instruction required."
          },
          "409": {
            "description": "Revision/idempotency conflict; reread before another operation."
          },
          "503": {
            "description": "Unconfirmed. Retry the unchanged packet/key or inspect exact record."
          }
        }
      }
    },
    "/learner/tools/read_grade_outcomes": {
      "post": {
        "operationId": "readGradeOutcomes",
        "summary": "read grade outcomes",
        "description": "Read private assessment outcomes and provenance. Reported is not verified. Suggestions never change hypothesis status until the student approves in Profile.",
        "x-openai-isConsequential": false,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "course": {
                    "type": "string",
                    "enum": [
                      "BUSN5000",
                      "MGMT4280",
                      "MGMT5560",
                      "MGMT5850",
                      "LAND2510",
                      "BUSN3040"
                    ]
                  },
                  "term_id": {
                    "type": "string",
                    "enum": [
                      "fall-2026"
                    ]
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false
                  },
                  "item_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160
                  },
                  "outcome_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160
                  },
                  "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100
                  },
                  "offset": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": []
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Authenticated learner result; mutations require exact readback.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "item_count": {
                      "type": "integer"
                    },
                    "items": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "hypotheses": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "outcomes": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "reviews": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    }
                  },
                  "additionalProperties": true
                }
              }
            }
          },
          "400": {
            "description": "Invalid request; inspect exact errors."
          },
          "401": {
            "description": "Existing authorized school connection required."
          },
          "403": {
            "description": "Scope or explicit student instruction required."
          },
          "409": {
            "description": "Revision/idempotency conflict; reread before another operation."
          },
          "503": {
            "description": "Unconfirmed. Retry the unchanged packet/key or inspect exact record."
          }
        }
      }
    },
    "/pass/tools/get_pass_protocol": {
      "post": {
        "operationId": "getPassProtocol",
        "summary": "Get pass protocol",
        "description": "Read the latest original PASS protocol before Save/Resume a PASS. Its storage bucket does not limit its all-class scope.",
        "x-openai-isConsequential": false,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Complete PASS result, including fresh readback for confirmed saves.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true,
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "markdown": {
                      "type": "string"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "save_confirmation": {
                      "type": "string"
                    },
                    "record": {
                      "type": "object"
                    },
                    "recorded": {
                      "type": "object"
                    },
                    "records": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "next_cursor": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "retry_arguments": {
                      "type": "object"
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "Invalid or ambiguous input; nothing confirmed saved."
          },
          "401": {
            "description": "Original authorization required."
          },
          "409": {
            "description": "Revision or operation-key conflict. Reread before a new correction."
          },
          "503": {
            "description": "Unavailable/unconfirmed; retain the exact retry packet."
          }
        }
      }
    },
    "/pass/tools/list_passes": {
      "post": {
        "operationId": "listPasses",
        "summary": "List passes",
        "description": "Discover canonical classes and retained PASS summaries. Resolve topic/date requests through these summaries, then read the selected record. Follow next_cursor.",
        "x-openai-isConsequential": false,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "course": {
                    "type": "string",
                    "description": "Explicit class code, label, number or full title. Takes precedence over contextual mentions."
                  },
                  "context": {
                    "type": "string",
                    "maxLength": 12000,
                    "description": "Full relevant session/handoff context used to identify the class. Multiple classes require selection."
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false,
                    "description": "True only for explicit synthetic connection tests; isolated from normal PASS discovery and resume."
                  },
                  "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 20,
                    "default": 10
                  },
                  "cursor": {
                    "type": "string",
                    "maxLength": 2300
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Complete PASS result, including fresh readback for confirmed saves.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true,
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "markdown": {
                      "type": "string"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "save_confirmation": {
                      "type": "string"
                    },
                    "record": {
                      "type": "object"
                    },
                    "recorded": {
                      "type": "object"
                    },
                    "records": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "next_cursor": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "retry_arguments": {
                      "type": "object"
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "Invalid or ambiguous input; nothing confirmed saved."
          },
          "401": {
            "description": "Original authorization required."
          },
          "409": {
            "description": "Revision or operation-key conflict. Reread before a new correction."
          },
          "503": {
            "description": "Unavailable/unconfirmed; retain the exact retry packet."
          }
        }
      }
    },
    "/pass/tools/read_pass": {
      "post": {
        "operationId": "readPass",
        "summary": "Read pass",
        "description": "Read an exact original PASS, preserving provenance and portable Markdown. Missing or unavailable records are errors, never invented memory.",
        "x-openai-isConsequential": false,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "course": {
                    "type": "string",
                    "description": "Explicit class code, label, number or full title. Takes precedence over contextual mentions."
                  },
                  "context": {
                    "type": "string",
                    "maxLength": 12000,
                    "description": "Full relevant session/handoff context used to identify the class. Multiple classes require selection."
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false,
                    "description": "True only for explicit synthetic connection tests; isolated from normal PASS discovery and resume."
                  },
                  "record_id": {
                    "type": "string",
                    "maxLength": 2200
                  }
                },
                "required": [
                  "record_id"
                ]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Complete PASS result, including fresh readback for confirmed saves.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true,
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "markdown": {
                      "type": "string"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "save_confirmation": {
                      "type": "string"
                    },
                    "record": {
                      "type": "object"
                    },
                    "recorded": {
                      "type": "object"
                    },
                    "records": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "next_cursor": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "retry_arguments": {
                      "type": "object"
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "Invalid or ambiguous input; nothing confirmed saved."
          },
          "401": {
            "description": "Original authorization required."
          },
          "409": {
            "description": "Revision or operation-key conflict. Reread before a new correction."
          },
          "503": {
            "description": "Unavailable/unconfirmed; retain the exact retry packet."
          }
        }
      }
    },
    "/pass/tools/resume_pass": {
      "post": {
        "operationId": "resumePass",
        "summary": "Resume pass",
        "description": "Resume by named class or exact session/record. Resolve ambiguity before continuing. Read the protocol first; source and saved facts never prove mastery or submission.",
        "x-openai-isConsequential": false,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "course": {
                    "type": "string",
                    "description": "Explicit class code, label, number or full title. Takes precedence over contextual mentions."
                  },
                  "context": {
                    "type": "string",
                    "maxLength": 12000,
                    "description": "Full relevant session/handoff context used to identify the class. Multiple classes require selection."
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false,
                    "description": "True only for explicit synthetic connection tests; isolated from normal PASS discovery and resume."
                  },
                  "record_id": {
                    "type": "string",
                    "maxLength": 2200
                  },
                  "session_id": {
                    "type": "string",
                    "maxLength": 128
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Complete PASS result, including fresh readback for confirmed saves.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true,
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "markdown": {
                      "type": "string"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "save_confirmation": {
                      "type": "string"
                    },
                    "record": {
                      "type": "object"
                    },
                    "recorded": {
                      "type": "object"
                    },
                    "records": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "next_cursor": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "retry_arguments": {
                      "type": "object"
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "Invalid or ambiguous input; nothing confirmed saved."
          },
          "401": {
            "description": "Original authorization required."
          },
          "409": {
            "description": "Revision or operation-key conflict. Reread before a new correction."
          },
          "503": {
            "description": "Unavailable/unconfirmed; retain the exact retry packet."
          }
        }
      }
    },
    "/pass/tools/save_pass": {
      "post": {
        "operationId": "savePass",
        "summary": "Save pass",
        "description": "Save requested factual PASS with sources and a next action. Require current revision and a stable retry key. Confirm only after matching receipt/readback. No learning/progress changes. Sandbox is only for explicit synthetic tests.",
        "x-openai-isConsequential": true,
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "course": {
                    "type": "string",
                    "description": "Explicit class code, label, number or full title. Takes precedence over contextual mentions."
                  },
                  "context": {
                    "type": "string",
                    "maxLength": 12000,
                    "description": "Full relevant session/handoff context used to identify the class. Multiple classes require selection."
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false,
                    "description": "True only for explicit synthetic connection tests; isolated from normal PASS discovery and resume."
                  },
                  "record_id": {
                    "type": "string",
                    "maxLength": 2200
                  },
                  "session_id": {
                    "type": "string",
                    "maxLength": 128
                  },
                  "date": {
                    "type": "string",
                    "format": "date"
                  },
                  "title": {
                    "type": "string",
                    "maxLength": 200
                  },
                  "goal": {
                    "type": "string",
                    "maxLength": 300
                  },
                  "section": {
                    "type": "string",
                    "maxLength": 80
                  },
                  "recorded_by": {
                    "type": "string",
                    "maxLength": 80
                  },
                  "next_step": {
                    "type": "string",
                    "maxLength": 600
                  },
                  "expected_revision": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "idempotency_key": {
                    "type": "string",
                    "maxLength": 160
                  },
                  "facts": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 12,
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "text": {
                          "type": "string",
                          "maxLength": 600
                        },
                        "basis": {
                          "type": "string",
                          "enum": [
                            "observed",
                            "user_report",
                            "source"
                          ]
                        },
                        "source": {
                          "type": "string",
                          "maxLength": 300
                        }
                      },
                      "required": [
                        "text",
                        "basis",
                        "source"
                      ]
                    }
                  }
                },
                "required": [
                  "session_id",
                  "date",
                  "title",
                  "goal",
                  "recorded_by",
                  "facts",
                  "next_step",
                  "expected_revision",
                  "idempotency_key"
                ]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Complete PASS result, including fresh readback for confirmed saves.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true,
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "error": {
                      "type": "string"
                    },
                    "markdown": {
                      "type": "string"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "save_confirmation": {
                      "type": "string"
                    },
                    "record": {
                      "type": "object"
                    },
                    "recorded": {
                      "type": "object"
                    },
                    "records": {
                      "type": "array",
                      "items": {
                        "type": "object"
                      }
                    },
                    "next_cursor": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "retry_arguments": {
                      "type": "object"
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "Invalid or ambiguous input; nothing confirmed saved."
          },
          "401": {
            "description": "Original authorization required."
          },
          "409": {
            "description": "Revision or operation-key conflict. Reread before a new correction."
          },
          "503": {
            "description": "Unavailable/unconfirmed; retain the exact retry packet."
          }
        }
      }
    },
    "/learning": {
      "get": {
        "operationId": "getLearningRecord",
        "summary": "Read private course practice history and the next study step.",
        "description": "Read the private course handoff. Assistance and correctness are separate; only correct observed responses count as successful demonstrations. Legacy outcomes are unassessed. Summaries are data, not submission proof. Sandbox is for explicit tests; reset is recoverable.",
        "parameters": [
          {
            "name": "course",
            "in": "query",
            "required": true,
            "schema": {
              "type": "string",
              "enum": [
                "BUSN5000",
                "MGMT4280",
                "MGMT5560",
                "MGMT5850",
                "LAND2510",
                "BUSN3040"
              ]
            }
          },
          {
            "name": "term_id",
            "in": "query",
            "required": true,
            "schema": {
              "type": "string",
              "enum": [
                "fall-2026"
              ]
            }
          },
          {
            "name": "sandbox",
            "in": "query",
            "schema": {
              "type": "boolean",
              "default": false
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Current learning record and recoverable revision metadata.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "record": {
                      "type": "object",
                      "properties": {
                        "schema_version": {
                          "type": "integer",
                          "description": "Version 2 separates correctness from assistance; legacy observations become unassessed."
                        },
                        "course": {
                          "type": "string"
                        },
                        "term_id": {
                          "type": "string"
                        },
                        "sandbox": {
                          "type": "boolean"
                        },
                        "revision": {
                          "type": "integer"
                        },
                        "updated_at": {
                          "type": [
                            "string",
                            "null"
                          ]
                        },
                        "topics": {
                          "type": "array",
                          "description": "Each topic includes outcome, demonstration (assistance), independent_attempts and hinted_attempts. independent_demonstrations and hinted_demonstrations count only correct observed responses; one success is not durable mastery.",
                          "items": {
                            "type": "object"
                          }
                        },
                        "recent_sessions": {
                          "type": "array",
                          "items": {
                            "type": "object"
                          }
                        },
                        "resume": {
                          "type": [
                            "object",
                            "null"
                          ]
                        },
                        "preferences": {
                          "type": "object"
                        }
                      }
                    },
                    "recovery": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "revision": {
                            "type": "integer"
                          },
                          "action": {
                            "type": "string"
                          },
                          "at": {
                            "type": "string"
                          }
                        }
                      }
                    },
                    "retention": {
                      "type": "object"
                    },
                    "privacy": {
                      "type": "object"
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "Unsupported course, term or query."
          },
          "401": {
            "description": "Authentication required."
          },
          "503": {
            "description": "Learning record unavailable; do not invent a handoff."
          }
        }
      },
      "post": {
        "operationId": "updateLearningRecord",
        "summary": "Save practice evidence, change preferences, or recoverably remove learning data.",
        "description": "Save short observations, never raw answers, transcripts, grades or credentials. Require current revision and a stable retry key. Confirm the metadata receipt with getLearningRecord. Forget/reset retain ten recoverable revisions. Practice does not complete coursework.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "action",
                  "course",
                  "term_id",
                  "expected_revision",
                  "idempotency_key"
                ],
                "properties": {
                  "action": {
                    "type": "string",
                    "enum": [
                      "save_session",
                      "update_preferences",
                      "forget_topic",
                      "reset",
                      "restore_revision"
                    ]
                  },
                  "course": {
                    "type": "string",
                    "enum": [
                      "BUSN5000",
                      "MGMT4280",
                      "MGMT5560",
                      "MGMT5850",
                      "LAND2510",
                      "BUSN3040"
                    ]
                  },
                  "term_id": {
                    "type": "string",
                    "enum": [
                      "fall-2026"
                    ]
                  },
                  "sandbox": {
                    "type": "boolean",
                    "default": false
                  },
                  "expected_revision": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "idempotency_key": {
                    "type": "string",
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:-]*$",
                    "description": "One stable key per logical save. Retry the exact packet and key after an uncertain response."
                  },
                  "topic_id": {
                    "type": "string",
                    "maxLength": 100,
                    "description": "Required only for forget_topic. Removes the topic from the active record; recovery snapshots remain bounded."
                  },
                  "restore_revision": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Required only for restore_revision; choose a revision listed in recovery."
                  },
                  "preferences": {
                    "type": "object",
                    "additionalProperties": false,
                    "description": "Required only for update_preferences. Include only explicitly stated preferences.",
                    "properties": {
                      "explanation_style": {
                        "type": "string",
                        "enum": [
                          "concise",
                          "step_by_step",
                          "examples_first"
                        ]
                      },
                      "time_budget_minutes": {
                        "type": "integer",
                        "minimum": 5,
                        "maximum": 180
                      },
                      "practice_focus": {
                        "type": "string",
                        "enum": [
                          "conceptual",
                          "code",
                          "interpretation",
                          "mixed"
                        ]
                      }
                    }
                  },
                  "session": {
                    "type": "object",
                    "additionalProperties": false,
                    "description": "Required only for save_session. Other actions must omit it.",
                    "required": [
                      "session_id",
                      "goal",
                      "observations"
                    ],
                    "properties": {
                      "session_id": {
                        "type": "string",
                        "maxLength": 128,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:-]*$"
                      },
                      "goal": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 240
                      },
                      "observations": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 8,
                        "items": {
                          "$ref": "#/components/schemas/LearningObservation"
                        }
                      },
                      "resume": {
                        "type": [
                          "object",
                          "null"
                        ],
                        "additionalProperties": false,
                        "required": [
                          "topic_id",
                          "next_step"
                        ],
                        "properties": {
                          "topic_id": {
                            "type": "string",
                            "maxLength": 100
                          },
                          "next_step": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 240
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Atomic metadata receipt. GET the record to confirm the saved revision; a replay never restores old content.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "course": {
                      "type": "string"
                    },
                    "term_id": {
                      "type": "string"
                    },
                    "sandbox": {
                      "type": "boolean"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "replayed": {
                      "type": "boolean"
                    },
                    "receipt": {
                      "type": "object",
                      "properties": {
                        "action": {
                          "type": "string"
                        },
                        "at": {
                          "type": "string"
                        }
                      }
                    },
                    "readback_required": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "Invalid, restricted or contradictory learning data."
          },
          "401": {
            "description": "Authentication required."
          },
          "404": {
            "description": "Topic or recoverable revision unavailable."
          },
          "409": {
            "description": "Revision, retry identity, session or capacity conflict. Reread before a new logical save."
          },
          "413": {
            "description": "Packet too large."
          },
          "503": {
            "description": "Save unconfirmed. Retry the same packet and operation ID, then read the record."
          }
        }
      }
    },
    "/status": {
      "get": {
        "operationId": "getCourseStatus",
        "summary": "Get what is currently due, what class is next, and the latest note from Claude.",
        "description": "Read live coursework state on the first reply and lead with briefing. Reuse it as of local_time on later turns. Refresh on request, a slash command, a new day, or a save conflict. Only linked completions clear deadlines; identity_review needs clarification. See call_policy.",
        "parameters": [
          {
            "name": "course",
            "in": "query",
            "required": true,
            "description": "Course code, e.g. BUSN5000, MGMT4280, MGMT5560, MGMT5850, LAND2510, BUSN3040.",
            "schema": {
              "type": "string",
              "enum": [
                "BUSN5000",
                "MGMT4280",
                "MGMT5560",
                "MGMT5850",
                "LAND2510",
                "BUSN3040"
              ]
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Current status.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "term_id": {
                      "type": "string"
                    },
                    "generated_at": {
                      "type": "string"
                    },
                    "identity_review": {
                      "type": "array",
                      "description": "Preserved reports without a safe current assignment link. Do not use these to clear deadlines.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "record_id": {
                            "type": "string"
                          },
                          "revision": {
                            "type": "integer"
                          },
                          "course": {
                            "type": "string"
                          },
                          "item": {
                            "type": "string"
                          },
                          "status": {
                            "type": "string"
                          },
                          "identity_reason": {
                            "type": [
                              "string",
                              "null"
                            ]
                          }
                        }
                      }
                    },
                    "local_time": {
                      "type": "string",
                      "description": "Current date and time in Athens, GA."
                    },
                    "briefing": {
                      "type": "string",
                      "description": "A short summary written to be delivered to Daksh verbatim."
                    },
                    "course": {
                      "type": "object",
                      "properties": {
                        "code": {
                          "type": "string"
                        },
                        "label": {
                          "type": "string"
                        },
                        "title": {
                          "type": "string"
                        },
                        "instructor": {
                          "type": "string"
                        },
                        "ai_policy": {
                          "type": "string",
                          "description": "One of encouraged, banned-on-assignments, unconfirmed. If banned-on-assignments, help him study but never draft graded work."
                        },
                        "ai_note": {
                          "type": "string"
                        }
                      }
                    },
                    "actionable": {
                      "type": "object",
                      "description": "The one view every client counts from. outstanding is what is genuinely left; safely linked done reports are excluded from it and appears under completed instead. Use these counts rather than re-deriving them from the lists below.",
                      "properties": {
                        "scope": {
                          "type": "string"
                        },
                        "counts": {
                          "type": "object",
                          "description": "outstanding, overdue, due_today, due_this_week, completed, awaiting_verification, verified, no_submission_required, blocked, ambiguous. verified, awaiting_verification and no_submission_required partition completed exactly."
                        },
                        "horizon": {
                          "type": "object",
                          "description": "What the lists actually span: overdue_lookback_days 10, due_window_days 7, upcoming_window_days 21. outstanding covers all of it, so never describe it as \"this week\"."
                        },
                        "scoped_next_7_days": {
                          "type": "object",
                          "description": "The only seven-day figure that is true for this course: outstanding across overdue, due_today and due_this_week only."
                        },
                        "outstanding": {
                          "type": "array",
                          "description": "Everything still owed, most urgent first, each tagged with its bucket.",
                          "items": {
                            "$ref": "#/components/schemas/ActionItem"
                          }
                        },
                        "awaiting_verification": {
                          "type": "array",
                          "description": "Reported done, but the bridge has seen no submission receipt. Treat as finished for planning; never say a submission is confirmed. Excludes work that needs no submission.",
                          "items": {
                            "$ref": "#/components/schemas/ActionItem"
                          }
                        },
                        "verified_submissions": {
                          "type": "array",
                          "description": "Completed work whose submission was actually observed.",
                          "items": {
                            "$ref": "#/components/schemas/ActionItem"
                          }
                        },
                        "no_submission_required": {
                          "type": "array",
                          "description": "Completed work with nothing to hand in \u2014 a reading, a setup task. Neither awaiting a receipt nor evidence that one was seen.",
                          "items": {
                            "$ref": "#/components/schemas/ActionItem"
                          }
                        },
                        "coverage": {
                          "type": "object",
                          "description": "What was and was not checked. feeds_status is ok, degraded or unknown \u2014 unknown means it is not confirmed the calendars were read, which is not a clear week. submission_sources_checked is false: the bridge reads calendars, not submission pages."
                        }
                      }
                    },
                    "overdue": {
                      "type": "array",
                      "description": "Deadlines already past, including ones he has reported done \u2014 those carry completed:true and are already excluded from actionable.counts.",
                      "items": {
                        "$ref": "#/components/schemas/Deadline"
                      }
                    },
                    "due_today": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/Deadline"
                      }
                    },
                    "due_this_week": {
                      "type": "array",
                      "description": "Due within seven days.",
                      "items": {
                        "$ref": "#/components/schemas/Deadline"
                      }
                    },
                    "upcoming": {
                      "type": "array",
                      "description": "Eight to twenty-one days out.",
                      "items": {
                        "$ref": "#/components/schemas/Deadline"
                      }
                    },
                    "classes_today": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/Meeting"
                      }
                    },
                    "classes_tomorrow": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/Meeting"
                      }
                    },
                    "other_courses_this_week": {
                      "type": "array",
                      "description": "Competing load in his other five courses. Use it to judge how much time he actually has.",
                      "items": {
                        "$ref": "#/components/schemas/Deadline"
                      }
                    },
                    "optional_this_week": {
                      "type": "array",
                      "description": "Readings, videos, podcasts, practice sets and bonus-point items for this week. None of this appears in any calendar, so Daksh will not have seen it anywhere else. Raise these unprompted and ask him one at a time whether he wants to do them \u2014 do not just list them. An item with graded=true is optional but still carries points.",
                      "items": {
                        "$ref": "#/components/schemas/OptionalItem"
                      }
                    },
                    "optional_ongoing": {
                      "type": "array",
                      "description": "Recurring expectations with no single date, e.g. reading before every class.",
                      "items": {
                        "$ref": "#/components/schemas/OptionalItem"
                      }
                    },
                    "optional_not_tracked": {
                      "type": "string",
                      "description": "Non-null when this course's optional material has not been transcribed yet. If set, say plainly that readings and videos are not tracked for this course rather than implying there are none."
                    },
                    "claude_note": {
                      "type": "object",
                      "description": "The most recent note left by Claude about what they were working on.",
                      "properties": {
                        "text": {
                          "type": "string"
                        },
                        "at_local": {
                          "type": "string"
                        }
                      }
                    },
                    "data_warning": {
                      "type": "string",
                      "description": "Non-null when a calendar feed failed to load. If set, say so out loud before relying on the list \u2014 it may be incomplete."
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "Unknown course code."
          },
          "401": {
            "description": "Missing or invalid API key."
          }
        }
      }
    },
    "/progress": {
      "post": {
        "operationId": "recordProgress",
        "summary": "Record that Daksh finished, started, or is blocked on a piece of coursework.",
        "description": "Record real progress. Use the current assignment_id, term_id and progress_record revision from status. Confirm only after ok:true. Keep the same idempotency_key when retrying. Ambiguous or reused titles require an explicit reference; errors are not saved completions.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "course",
                  "item"
                ],
                "properties": {
                  "course": {
                    "type": "string",
                    "description": "Course code.",
                    "enum": [
                      "BUSN5000",
                      "MGMT4280",
                      "MGMT5560",
                      "MGMT5850",
                      "LAND2510",
                      "BUSN3040",
                      "GENERAL"
                    ]
                  },
                  "item": {
                    "type": "string",
                    "description": "The coursework item, worded as close to the deadline title as possible, e.g. \"Quiz 01 _Origins\". Also send its current assignment_id when available."
                  },
                  "status": {
                    "type": "string",
                    "description": "Defaults to done when omitted. done means it was turned in; work he has finished but not submitted is in_progress.",
                    "enum": [
                      "done",
                      "in_progress",
                      "blocked",
                      "not_started"
                    ]
                  },
                  "assignment_id": {
                    "type": "string",
                    "description": "Current assignment_id from getCourseStatus. Scoped to term, course and source; survives renaming."
                  },
                  "term_id": {
                    "type": "string",
                    "description": "Current term_id from status."
                  },
                  "when_iso": {
                    "type": "string",
                    "description": "Exact current due timestamp from status; helps disambiguate repeated titles."
                  },
                  "record_id": {
                    "type": "string",
                    "description": "Existing progress_record.record_id when updating or explicitly relinking."
                  },
                  "expected_revision": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Existing progress_record.revision, or 0 for a new record. A conflict requires a fresh read."
                  },
                  "relink": {
                    "type": "boolean",
                    "description": "True only after an explicit choice to link an existing report to a different assignment. Requires record_id and expected_revision."
                  },
                  "idempotency_key": {
                    "type": "string",
                    "maxLength": 160,
                    "description": "Unique key for this logical save. Reuse exactly on every retry, including after a timeout."
                  },
                  "verification": {
                    "type": "string",
                    "description": "What is actually KNOWN about the submission, which is a different claim from the work being finished. Use verified only if an original submission or full-completion receipt was actually seen; grades alone are not proof. Evidence is required. Use not_required when nothing must be handed in. Omit to keep whatever is already on file for an unchanged status; a new item defaults to reported when done.",
                    "enum": [
                      "verified",
                      "reported",
                      "unknown",
                      "not_required"
                    ]
                  },
                  "evidence": {
                    "type": "string",
                    "description": "What was observed, when verification is verified. Required in that case; the call is rejected without it."
                  },
                  "submitted_by": {
                    "type": "string",
                    "description": "Who turned it in. Use group for a teammate's submission you have not confirmed.",
                    "enum": [
                      "self",
                      "group",
                      "instructor",
                      "unknown"
                    ]
                  },
                  "reported_by": {
                    "type": "string",
                    "description": "Who is making the claim, e.g. daksh or codex."
                  },
                  "note": {
                    "type": "string",
                    "description": "Optional provenance or blocker. Never include grades or scores."
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Recorded.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    },
                    "operation_id": {
                      "type": "string"
                    },
                    "revision": {
                      "type": "integer"
                    },
                    "warning": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "recorded": {
                      "type": "object",
                      "properties": {
                        "record_id": {
                          "type": "string"
                        },
                        "assignment_id": {
                          "type": [
                            "string",
                            "null"
                          ]
                        },
                        "term_id": {
                          "type": "string"
                        },
                        "revision": {
                          "type": "integer"
                        },
                        "identity_resolution": {
                          "type": "string"
                        }
                      }
                    },
                    "course": {
                      "type": "string"
                    },
                    "tracked": {
                      "type": "integer",
                      "description": "How many items are now tracked for this course."
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "Unknown course, missing item, invalid status, or verified without evidence.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "error": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          },
          "409": {
            "description": "Ambiguous identity, reused title, or stale revision. Nothing changed by this attempt; use returned candidates or reread status."
          },
          "503": {
            "description": "Source or storage unavailable. Check error and operation_id; retry the same key. Never claim success without acknowledgement."
          }
        }
      }
    },
    "/library": {
      "get": {
        "operationId": "searchLibrary",
        "summary": "Find an original course document (PDF, slides, syllabus) in Google Drive.",
        "description": "Secondary source \u2014 answer from Knowledge first. Use when Knowledge disagrees with itself, looks stale, lacks a document, or Daksh wants the file itself. Returns the Drive originals newest first, each with a doc_id for getDocument and an openable link. Omit q to list the whole course.",
        "parameters": [
          {
            "name": "course",
            "in": "query",
            "required": false,
            "schema": {
              "type": "string",
              "enum": [
                "BUSN5000",
                "MGMT4280",
                "MGMT5560",
                "MGMT5850",
                "LAND2510",
                "BUSN3040"
              ]
            },
            "description": "Restrict to one course. Omit to search every course."
          },
          {
            "name": "q",
            "in": "query",
            "required": false,
            "schema": {
              "type": "string"
            },
            "description": "A filename term or lecture concept, e.g. \"syllabus\", \"craft beer\", \"value chain\". Searches filenames and Drive-indexed contents; multiword content queries match a phrase. Use getDocument to verify the actual passage."
          },
          {
            "name": "limit",
            "in": "query",
            "required": false,
            "schema": {
              "type": "integer",
              "default": 25,
              "maximum": 50
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Matching documents.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "course": {
                      "type": "string"
                    },
                    "count": {
                      "type": "integer"
                    },
                    "documents": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/LibraryDocument"
                      }
                    }
                  }
                }
              }
            }
          },
          "501": {
            "description": "Drive credentials are not configured on the bridge."
          }
        }
      }
    },
    "/library/doc": {
      "get": {
        "operationId": "getDocument",
        "summary": "Read the full text of one original document from Drive.",
        "description": "Full text of one document from searchLibrary. Use it to check a claim against the original, not to browse. `source` is drive_export (Drive's own, exact) or sweep_extraction (derived). Null `text` means nothing can read it \u2014 give the link. The original outranks Knowledge.",
        "parameters": [
          {
            "name": "id",
            "in": "query",
            "required": true,
            "schema": {
              "type": "string"
            },
            "description": "The `doc_id` from searchLibrary."
          },
          {
            "name": "max_chars",
            "in": "query",
            "required": false,
            "schema": {
              "type": "integer",
              "default": 60000,
              "maximum": 120000
            },
            "description": "Truncate long documents. `truncated` says whether it was cut."
          }
        ],
        "responses": {
          "200": {
            "description": "The document and its text.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "document": {
                      "$ref": "#/components/schemas/LibraryDocument"
                    },
                    "text": {
                      "type": [
                        "string",
                        "null"
                      ],
                      "description": "Null when no extractor can read this file type."
                    },
                    "truncated": {
                      "type": "boolean"
                    },
                    "source": {
                      "type": [
                        "string",
                        "null"
                      ],
                      "description": "drive_export, drive_download, or sweep_extraction."
                    },
                    "pages": {
                      "type": [
                        "integer",
                        "null"
                      ]
                    },
                    "reason": {
                      "type": "string",
                      "description": "Present when text is null, explaining why."
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "Missing doc_id."
          },
          "501": {
            "description": "Drive credentials are not configured on the bridge."
          }
        }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer"
      }
    },
    "schemas": {
      "LearningObservation": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "topic_id",
          "label",
          "demonstration",
          "outcome",
          "evidence",
          "practice_kind",
          "next_step"
        ],
        "properties": {
          "topic_id": {
            "type": "string",
            "maxLength": 100,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:-]*$"
          },
          "label": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "demonstration": {
            "type": "string",
            "enum": [
              "independent",
              "with_hints",
              "explanation_only",
              "untested"
            ],
            "description": "Assistance during the learner response, independent of correctness. independent/with_hints require an observed response; an incorrect unaided attempt is independent with outcome incorrect. Explanations given afterward do not change the earlier assistance classification."
          },
          "outcome": {
            "type": "string",
            "enum": [
              "correct",
              "partial",
              "incorrect",
              "not_attempted",
              "unassessed"
            ],
            "description": "Qualitative result for this precise topic, separate from assistance and without scores. Assessed outcomes require observed_response with independent/with_hints. Only correct responses increase successful demonstrations. Generated practice, explanations and self-report stay unassessed. Missing outcome from legacy clients is unassessed."
          },
          "evidence": {
            "type": "string",
            "enum": [
              "observed_response",
              "learner_report",
              "discussion_only",
              "practice_generated"
            ],
            "description": "Use observed_response only for a response actually seen; explanation_only requires discussion_only."
          },
          "practice_kind": {
            "type": "string",
            "enum": [
              "conceptual",
              "code",
              "interpretation",
              "mixed"
            ]
          },
          "misconception": {
            "type": "string",
            "maxLength": 200
          },
          "next_step": {
            "type": "string",
            "minLength": 1,
            "maxLength": 240
          },
          "source_refs": {
            "type": "array",
            "maxItems": 4,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "doc_id",
                "title"
              ],
              "properties": {
                "doc_id": {
                  "type": "string",
                  "maxLength": 180
                },
                "title": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160
                },
                "locator": {
                  "type": "string",
                  "maxLength": 120
                }
              }
            }
          }
        }
      },
      "Deadline": {
        "type": "object",
        "properties": {
          "assignment_id": {
            "type": [
              "string",
              "null"
            ]
          },
          "term_id": {
            "type": "string"
          },
          "when_iso": {
            "type": "string"
          },
          "progress_record": {
            "type": [
              "object",
              "null"
            ],
            "properties": {
              "record_id": {
                "type": "string"
              },
              "revision": {
                "type": "integer"
              },
              "status": {
                "type": "string"
              }
            }
          },
          "title": {
            "type": "string"
          },
          "course": {
            "type": "string"
          },
          "when": {
            "type": "string",
            "description": "Human-readable local due time, e.g. \"Sat, Aug 22, 11:59 PM\"."
          },
          "days_away": {
            "type": "integer",
            "description": "Whole calendar days from today. 0 means today."
          },
          "days_late": {
            "type": "integer",
            "description": "Present only on overdue items."
          },
          "outstanding": {
            "type": "boolean",
            "description": "False once he has reported the item done."
          },
          "completed": {
            "type": "boolean",
            "description": "Present and true only when a progress report matched this deadline."
          },
          "completion": {
            "type": "object",
            "description": "How the report was matched, and separately what is known about the submission. They are different claims and must not be merged.",
            "properties": {
              "match_method": {
                "type": "string",
                "description": "source_identity \u2014 linked to a scoped source record at write time. exact \u2014 legacy exact title match. unique_alias \u2014 looser wording that matched exactly one deadline in that course. Neither is evidence that anything was submitted.",
                "enum": [
                  "source_identity",
                  "exact",
                  "unique_alias",
                  "unresolved"
                ]
              },
              "submission_verification": {
                "type": "string",
                "description": "verified \u2014 an original submission or full-completion receipt was actually observed. Grades alone are not completion proof. reported \u2014 he said so and nothing was checked. Never describe a reported item as confirmed or submitted-for-certain.",
                "enum": [
                  "verified",
                  "reported",
                  "unknown",
                  "not_required"
                ]
              },
              "confidence": {
                "type": "string",
                "description": "Legacy name for the title match only, kept for older clients. confirmed = explicit or exact initial match, inferred = unique initial alias. It says nothing about submission."
              },
              "evidence": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "evidence_limitation": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "Why nothing is verified. On an older record this says only that no structured evidence exists \u2014 it is not a claim that nothing was checked. Read reported_note before concluding either way."
              },
              "reported_note": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "The free-text note from the original report, preserved verbatim."
              },
              "submitted_by": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "reported_by": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "matched": {
                "type": "string"
              }
            }
          },
          "detail": {
            "type": "string"
          }
        }
      },
      "ActionItem": {
        "type": "object",
        "description": "A compact row from the shared actionable view.",
        "properties": {
          "assignment_id": {
            "type": [
              "string",
              "null"
            ]
          },
          "term_id": {
            "type": "string"
          },
          "progress_record": {
            "type": [
              "object",
              "null"
            ],
            "properties": {
              "record_id": {
                "type": "string"
              },
              "revision": {
                "type": "integer"
              },
              "status": {
                "type": "string"
              }
            }
          },
          "bucket": {
            "type": "string",
            "description": "overdue, due_today, due_this_week, other_courses_this_week or upcoming."
          },
          "title": {
            "type": "string"
          },
          "course": {
            "type": "string"
          },
          "course_code": {
            "type": [
              "string",
              "null"
            ]
          },
          "when": {
            "type": "string"
          },
          "when_iso": {
            "type": "string"
          },
          "days_away": {
            "type": "integer"
          },
          "days_late": {
            "type": "integer"
          },
          "submission_verification": {
            "type": "string"
          },
          "match_method": {
            "type": "string"
          },
          "evidence_limitation": {
            "type": [
              "string",
              "null"
            ]
          }
        }
      },
      "OptionalItem": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string"
          },
          "course": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "description": "One of reading, watch, listen, practice, bonus."
          },
          "window": {
            "type": "string",
            "description": "The week this belongs to, or \"ongoing\"."
          },
          "graded": {
            "type": "boolean",
            "description": "True when the item is optional but still worth points."
          },
          "note": {
            "type": "string"
          }
        }
      },
      "Meeting": {
        "type": "object",
        "properties": {
          "course": {
            "type": "string"
          },
          "when": {
            "type": "string"
          },
          "location": {
            "type": "string"
          }
        }
      },
      "LibraryDocument": {
        "type": "object",
        "properties": {
          "doc_id": {
            "type": "string",
            "description": "Pass this to getDocument."
          },
          "title": {
            "type": "string",
            "description": "The filename as it is stored in Drive."
          },
          "folder": {
            "type": "string",
            "description": "Where it sits, e.g. \"MGMT 4280/02 - Slides\"."
          },
          "type": {
            "type": "string",
            "description": "PDF, Google Doc, PowerPoint, Video, and so on."
          },
          "modified": {
            "type": "string",
            "description": "ISO date the file last changed in Drive."
          },
          "size_kb": {
            "type": [
              "integer",
              "null"
            ]
          },
          "link": {
            "type": [
              "string",
              "null"
            ],
            "description": "Open-in-Drive URL. Give this to Daksh when he wants the file itself."
          }
        }
      }
    }
  }
};
