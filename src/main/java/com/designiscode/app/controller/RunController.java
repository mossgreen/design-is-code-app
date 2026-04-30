package com.designiscode.app.controller;

import com.designiscode.app.dto.RunRequest;
import com.designiscode.app.service.RunService;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;

@RestController
@RequestMapping("/api")
public class RunController {

    private final RunService runService;

    public RunController(RunService runService) {
        this.runService = runService;
    }

    @PostMapping(value = "/run-disc", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseBodyEmitter runDisc(@RequestBody RunRequest request) {
        ResponseBodyEmitter emitter = new ResponseBodyEmitter(15L * 60L * 1000L);
        runService.run(request, emitter);
        return emitter;
    }
}
